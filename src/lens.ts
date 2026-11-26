// `ultraview lens new "<question>"` and `lens list`, as library calls
// (docs/design.md §7, §9 step 3).
//
//   lens new    the evidence pack the agent reads before answering a question:
//               a proposed id (slug of the question, de-duplicated against the
//               saved lenses), the target path, the JSON template, ranked
//               candidate nodes (ultraindex `runFind` over modules, mapped to
//               view node ids, slices included; before them, the routes /
//               screens / entities / jobs / symbols / capabilities named like
//               the question, ranked by `nameMatches`; a French question is
//               read through `lens-terms.ts`), their strongest edges, source excerpts (ultraindex
//               `gatherEvidence`) cut to a budget, and the closing instructions.
//   lens list   every saved lens: id, question, node count, stale flag (the
//               assembler's own staleness: a cited file's hash changed), and
//               when its file was last written.
//
// Read-only: neither writes anything. Deterministic: the same index, view and
// question give the same pack, byte for byte.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { codeindex, gatherEvidence, runFind } from "./engine.js";
import { extentFinder } from "./extract/extent.js";
import { stableJson } from "./json.js";
import { type QuestionReading, readQuestion } from "./lens-terms.js";
import { fileOfId, modId, SLUG_RE } from "./model/ids.js";
import { LENSES_DIR } from "./model/load.js";
import type { ViewEdge, ViewNode } from "./model/types.js";
import { viewPaths } from "./paths.js";
import { type LiveView, liveView } from "./show.js";

/** Default `lens new` budget, in tokens (~4 characters a token: ~24k characters). */
export const LENS_BUDGET = 6000;
const CHARS_PER_TOKEN = 4;
/** Modules asked of ultraindex find. */
const FIND_K = 6;
/** Candidate nodes listed from the name match. */
const MATCHES = 25;
/** Edges listed in the neighbourhood. */
const EDGES = 30;
/** Files whose head is excerpted. */
const EVIDENCE_FILES = 10;
const HEAD_LINES = 60;
/** Lines around a matched definition. */
const AROUND = 8;
/** Longest proposed id. */
const ID_MAX = 48;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface LensNewOptions {
  /** Token budget for the whole pack (default LENS_BUDGET). */
  budget?: number;
  /** Use this id instead of the proposed one (must be a slug). */
  id?: string;
}

export interface LensCandidate {
  id: string;
  kind: ViewNode["kind"];
  label: string;
  /** Where it is defined (`path:line`), for a detected node. */
  at?: string;
  /** Why it is a candidate: `find` (ultraindex module ranking) or `name` (its name matches the question). */
  via: "find" | "name";
  /** find: ultraindex's score; name: the rank score (rarer terms weigh more, a term in the name more than one in the body, plus the kind / method / capability bonuses). */
  score: number;
  /** The question terms it matched. */
  matched: string[];
}

export interface LensEvidence {
  rel: string;
  /** Repo-relative path with the excerpted range (`src/a.ts:1-60`). */
  range: string;
  text: string;
}

export interface LensTemplate {
  schema: 1;
  id: string;
  question: string;
  answer: string;
  nodes: string[];
  edges: { from: string; to: string }[];
  focus: string;
}

export interface LensPack {
  question: string;
  id: string;
  /** Repo-relative target path. */
  file: string;
  /** A saved lens already holds this question under `id`: saving replaces it (a re-ask). */
  reask: boolean;
  /** `--id` names a lens holding a different question: saving needs `--force`. */
  conflict?: string;
  terms: string[];
  template: LensTemplate;
  candidates: LensCandidate[];
  /** Capabilities the candidates serve. */
  capabilities: { id: string; label: string }[];
  neighbourhood: ViewEdge[];
  evidence: LensEvidence[];
  budget: number;
  /** The whole pack as plain text, the agent's reading. */
  text: string;
}

/** Saved lens files: id → question (undefined when the file does not parse). */
function savedQuestions(repo: string): Map<string, string | undefined> {
  const dir = join(repo, LENSES_DIR);
  const out = new Map<string, string | undefined>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    let question: string | undefined;
    try {
      const v = JSON.parse(readFileSync(join(dir, name), "utf8")) as { question?: unknown };
      if (typeof v.question === "string") question = v.question;
    } catch {
      // unreadable: still occupies the id
    }
    out.set(name.slice(0, -".json".length), question);
  }
  return out;
}

/** The slug of a question: folded to ASCII, lowercase, words joined by `-`, cut at a word under ID_MAX. */
export function questionSlug(question: string): string {
  const words = codeindex
    .foldText(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > ID_MAX) break;
    slug = next;
  }
  if (!slug && words.length) slug = words[0]!.slice(0, ID_MAX);
  return SLUG_RE.test(slug) ? slug : "lens";
}

/**
 * The id a new lens for `question` gets: its slug; when a saved lens already
 * holds that slug for a DIFFERENT question, `<slug>-2`, `-3`… A question some
 * saved lens already holds keeps that lens's id (asking again replaces the
 * answer, as `lens save` allows).
 */
export function proposeLensId(repo: string, question: string): { id: string; reask: boolean } {
  const saved = savedQuestions(resolve(repo));
  for (const [id, q] of saved) if (q === question) return { id, reask: true };
  const base = questionSlug(question);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!saved.has(id)) return { id, reask: false };
  }
}

/** Question terms, stemmed (`cancelling` → `cancel`, `orders` → `order`); a French question's words bridged to English (`commande` → `order`). */
export function questionTerms(question: string): string[] {
  return readQuestion(question).terms;
}

const NAME_KINDS: ReadonlySet<string> = new Set(["cap", "route", "screen", "entity", "job", "sym"]);
const KIND_ORDER = ["cap", "route", "screen", "entity", "job", "sym", "mod"];
/** A term found in a node's definition, fields or summary weighs this much of one found in its name. */
const DETAIL_SHARE = 0.5;
/** Bonus when the wording points at the node's kind (`fields` → an entity), its method (`fetch` → GET) or its cardinality (`by id` → `/:id`). */
const KIND_BONUS = 0.75;
const METHOD_BONUS = 0.75;
const CARDINALITY_BONUS = 0.5;
/** A member of a matching capability gets this share of the capability's score. */
const CAP_SHARE = 0.5;
/** Lines of a definition read for its words. */
const BODY_LINES = 40;

const lowerTokens = (text: string): string[] => {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_$]+/)) if (raw) for (const t of codeindex.subtokens(raw)) out.add(codeindex.foldText(t).toLowerCase());
  return [...out];
};

interface Hay {
  tokens: string[];
  whole: string;
}

const hay = (text: string): Hay => ({ tokens: lowerTokens(text), whole: text.toLowerCase() });

/** A stem matches a word it starts (`order` ⊂ `orders`), or, from 5 letters, any part of a run-together name (`item` ⊂ `orderitems`). */
function has(h: Hay, term: string): boolean {
  if (term === "id") return h.tokens.includes("id") || h.tokens.includes("ids");
  return h.tokens.some((t) => t.startsWith(term)) || (term.length >= 5 && h.whole.includes(term));
}

/** The words of a node's definition (`at` to the end of its statement, block or function), fields and summary. */
function detailText(repo: string, n: ViewNode, files: Map<string, string | undefined>): string {
  const parts: string[] = [];
  if (n.summary) parts.push(n.summary.replace(/\[[^\]]*\]/g, " "));
  if (n.actors) parts.push(n.actors.join(" "));
  for (const f of n.fields ?? []) parts.push(f.name, f.type, f.relation ?? "");
  if (n.at && n.kind !== "cap") {
    const i = n.at.lastIndexOf(":");
    const rel = n.at.slice(0, i);
    const line = Number(n.at.slice(i + 1));
    if (!files.has(rel)) {
      let text: string | undefined;
      try {
        text = codeindex.readText(join(repo, rel));
      } catch {
        text = undefined;
      }
      files.set(rel, text);
    }
    const text = files.get(rel);
    if (text !== undefined && Number.isInteger(line) && line >= 1) {
      const end = Math.min(extentFinder(rel, text)(line), line + BODY_LINES - 1);
      parts.push(
        text
          .split(/\r?\n/)
          .slice(line - 1, end)
          .join("\n"),
      );
    }
  }
  return parts.join("\n");
}

/** A route path that names one item (`/orders/:id`, `/orders/{id}`, `/orders/[id]`). */
const namesOne = (path: string) => /[:{[][^/]*[\]}]?$/.test(path.split("?")[0]!.replace(/\/+$/, ""));

/**
 * Nodes named like the question, ranked: each term weighs its rarity among
 * the candidates (idf), a term in the name counts fully and one only in the
 * definition, fields or summary counts DETAIL_SHARE; a node the wording points
 * at (kind, method, cardinality) or a member of a matching capability earns a
 * bonus on top.
 */
function nameMatches(repo: string, view: LiveView["view"], q: QuestionReading): LensCandidate[] {
  if (!q.terms.length) return [];
  const files = new Map<string, string | undefined>();
  const pool = view.nodes
    .filter((n) => NAME_KINDS.has(n.kind) && n.id !== "cap:_foundations")
    .map((n) => ({ n, name: hay(`${n.label} ${n.id.slice(n.kind.length + 1)}`), detail: hay(detailText(repo, n, files)) }));
  const df = new Map<string, number>();
  for (const t of q.terms) df.set(t, pool.filter((p) => has(p.name, t) || has(p.detail, t)).length);
  const idf = (t: string) => Math.log(1 + pool.length / (df.get(t) || 1));

  const base = new Map<string, { score: number; matched: string[] }>();
  for (const p of pool) {
    let score = 0;
    const matched: string[] = [];
    for (const t of q.terms) {
      const w = (q.weight.get(t) ?? 1) * idf(t);
      if (has(p.name, t)) score += w;
      else if (has(p.detail, t)) score += w * DETAIL_SHARE;
      else continue;
      matched.push(t);
    }
    if (matched.length) base.set(p.n.id, { score, matched });
  }

  const out: LensCandidate[] = [];
  for (const { n } of pool) {
    const b = base.get(n.id);
    if (!b) continue;
    let score = b.score;
    if (q.kinds.has(n.kind)) score += KIND_BONUS;
    if (n.kind === "route") {
      const sp = n.id.indexOf(" ");
      const method = n.id.slice("route:".length, sp);
      const path = n.id.slice(sp + 1);
      if (q.methods.has(method)) score += METHOD_BONUS;
      if (q.cardinality && (q.cardinality === "one") === namesOne(path)) score += CARDINALITY_BONUS;
    }
    let cap = 0;
    for (const c of n.caps ?? []) cap = Math.max(cap, base.get(c)?.score ?? 0);
    score += CAP_SHARE * cap;
    out.push({
      id: n.id,
      kind: n.kind,
      label: n.label,
      ...(n.at ? { at: n.at } : {}),
      via: "name",
      score: Math.round(score * 1000) / 1000,
      matched: b.matched,
    });
  }
  return out.sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cmp(a.id, b.id)).slice(0, MATCHES);
}

function findMatches(live: LiveView, indexDir: string, question: string): { candidates: LensCandidate[]; files: string[] } {
  const found = runFind(indexDir, question, FIND_K) ?? [];
  const candidates: LensCandidate[] = [];
  const files: string[] = [];
  for (const r of found) {
    if (r.score <= 0) continue;
    const whole = modId(r.slug);
    const ids = [whole, ...live.view.nodes.filter((n) => n.slice?.of === whole).map((n) => n.id)].filter((id) => live.byId.has(id));
    for (const id of ids) {
      const n = live.byId.get(id)!;
      candidates.push({
        id,
        kind: n.kind,
        label: n.slice ? `${n.label} ${n.slice.qualifier}` : n.label,
        via: "find",
        score: r.score,
        matched: [...r.matched].sort(),
      });
    }
    files.push(...r.files);
  }
  return { candidates, files };
}

function topEdges(view: LiveView["view"], ids: Set<string>): ViewEdge[] {
  const seen = new Set<string>();
  const out: ViewEdge[] = [];
  for (const e of view.edges) {
    if (!ids.has(e.from) && !ids.has(e.to)) continue;
    const key = `${e.from}\u0000${e.to}\u0000${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => b.weight - a.weight || cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind)).slice(0, EDGES);
}

function numbered(lines: string[], from: number, to: number): string {
  const width = String(to).length;
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width)}  ${l}`)
    .join("\n");
}

function readLines(repo: string, rel: string): string[] | undefined {
  try {
    return codeindex.readText(join(repo, rel)).split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** Excerpts: around each matched definition first, then the head of each found module's top files. */
function collectEvidence(repo: string, candidates: LensCandidate[], findFiles: string[]): LensEvidence[] {
  const out: LensEvidence[] = [];
  const headed = new Set<string>();
  for (const c of candidates) {
    if (!c.at || c.kind === "cap") continue;
    const i = c.at.lastIndexOf(":");
    const rel = c.at.slice(0, i);
    const line = Number(c.at.slice(i + 1));
    const lines = readLines(repo, rel);
    if (!lines || !Number.isInteger(line)) continue;
    const from = Math.max(1, line - 2);
    const to = Math.min(lines.length, line + AROUND);
    if (from > to) continue;
    out.push({ rel, range: `${rel}:${from}-${to}`, text: `### ${c.id}  [${rel}:${from}-${to}]\n\`\`\`\n${numbered(lines, from, to)}\n\`\`\`` });
  }
  const rels: string[] = [];
  for (const c of candidates) {
    const rel = fileOfId(c.id) ?? (c.at ? c.at.slice(0, c.at.lastIndexOf(":")) : undefined);
    if (rel && c.kind !== "cap") rels.push(rel);
  }
  rels.push(...findFiles);
  const unique: string[] = [];
  for (const r of rels) {
    if (headed.has(r)) continue;
    headed.add(r);
    unique.push(r);
  }
  unique.splice(EVIDENCE_FILES);
  for (const e of gatherEvidence(repo, unique, HEAD_LINES)) {
    const lines = readLines(repo, e.rel);
    const body = lines ? numbered(lines, 1, Math.min(lines.length, e.headTo)) : e.head;
    const parts = [`### ${e.rel} (${e.lines} lines)  [${e.rel}:1-${e.headTo}]`];
    if (e.exported.length) parts.push(`Exported: ${e.exported.map((s) => `${s.kind} ${s.name} @ ${s.line}`).join(", ")}`);
    parts.push("```", body, "```");
    out.push({ rel: e.rel, range: `${e.rel}:1-${e.headTo}`, text: parts.join("\n") });
  }
  return out;
}

function fmtCandidate(c: LensCandidate): string {
  return `- ${c.id}  (${c.label})${c.at ? `  [${c.at}]` : ""}  score ${c.score}: ${c.matched.join(", ") || "-"}`;
}

/** The closing instructions: what to write, where, and the gates to run. */
function instructions(pack: Pick<LensPack, "id" | "file" | "reask" | "conflict">): string {
  const lines = [
    "## Next",
    `1. Answer the question from the evidence above (open more files if you need to); \`ultraview show <node-id>\` and \`ultraview dossier <node-id>\` give more about one node.`,
    "2. Every sentence of `answer` cites the file it rests on as `[path:line]` (or `[path:start-end]`): `ultraview check` fails a dead citation and an uncited sentence.",
    "3. `nodes`: the node ids the answer is about (pick from the candidates, or any id `ultraview show` knows); `edges` (optional): the links between them that matter; `focus`: the one node to centre the map on.",
    `4. Write the JSON above, filled in, to ${pack.file}${pack.reask ? " (it already holds this question: the new answer replaces the old one)" : ""}. Leave \`sources\` out: \`lens save\` stamps it.`,
    `5. Run \`ultraview lens save ${pack.file}\`${pack.conflict ? " --force (the id holds a different question)" : ""}, then \`ultraview check\`, and fix what they report.`,
    `6. Point the user at \`#lens=${pack.id}\` in the map (live when \`ultraview serve\` runs).`,
  ];
  return lines.join("\n");
}

/** The pack for `question` over the live view of `repo`. */
export function lensNew(repoArg: string, question: string, opts: LensNewOptions = {}): LensPack {
  const repo = resolve(repoArg);
  const q = question.trim();
  if (!q) throw new Error("the question is empty");
  if (opts.id !== undefined && !SLUG_RE.test(opts.id)) throw new Error(`--id must be a slug (lowercase letters, digits, dashes): ${opts.id}`);
  const live = liveView(repo);
  const budget = opts.budget ?? LENS_BUDGET;

  let id: string;
  let reask: boolean;
  let conflict: string | undefined;
  if (opts.id !== undefined) {
    id = opts.id;
    const saved = savedQuestions(repo);
    reask = saved.has(id) && saved.get(id) === q;
    if (saved.has(id) && !reask) conflict = saved.get(id) ?? "(unreadable file)";
  } else ({ id, reask } = proposeLensId(repo, q));
  const file = `${LENSES_DIR}/${id}.json`;

  const reading = readQuestion(q);
  const terms = reading.terms;
  const found = findMatches(live, viewPaths(repo).index, q);
  const named = nameMatches(repo, live.view, reading);
  // Named nodes first, by rank: they are what an answer is about; the modules ultraindex finds frame them.
  const candidates = [...named, ...found.candidates.filter((f) => !named.some((n) => n.id === f.id))];
  const capIds = new Set<string>();
  for (const c of candidates) {
    if (c.kind === "cap") capIds.add(c.id);
    for (const cap of live.byId.get(c.id)?.caps ?? []) capIds.add(cap);
  }
  capIds.delete("cap:_foundations");
  const capabilities = [...capIds].sort(cmp).map((cid) => ({ id: cid, label: live.byId.get(cid)?.label ?? cid }));
  const neighbourhood = topEdges(live.view, new Set(candidates.map((c) => c.id)));
  const focus = named.find((c) => c.kind !== "cap")?.id ?? candidates[0]?.id ?? "";
  const template: LensTemplate = {
    schema: 1,
    id,
    question: q,
    answer: "Markdown. Every sentence cites [path:line].",
    nodes: (named.some((c) => c.kind !== "cap") ? named.filter((c) => c.kind !== "cap") : candidates.filter((c) => c.kind !== "mod"))
      .slice(0, 5)
      .map((c) => c.id),
    edges: [],
    focus,
  };

  const head = [
    `# Lens evidence — "${q}"`,
    "",
    `id        ${id}${reask ? "  (re-ask: a saved lens holds this question)" : ""}`,
    `file      ${file}`,
    ...(conflict !== undefined ? [`conflict  ${file} holds a different question ("${conflict}"): pick another --id, or save with --force`] : []),
    `terms     ${terms.join(", ") || "(none)"}`,
  ].join("\n");
  const cand = ["## Candidate nodes"];
  const fromFind = candidates.filter((c) => c.via === "find");
  const fromName = candidates.filter((c) => c.via === "name");
  if (fromName.length) cand.push("Named like the question (routes, screens, entities, jobs, symbols, capabilities):", ...fromName.map(fmtCandidate));
  if (fromFind.length) cand.push("Modules (ultraindex find):", ...fromFind.map(fmtCandidate));
  if (!candidates.length) cand.push("(nothing matched: try other words, or `ultraview show` / `dossier` on a node you know)");
  if (capabilities.length) cand.push(`Capabilities touched: ${capabilities.map((c) => `${c.id} (${c.label})`).join(", ")}`);
  const neigh = neighbourhood.length
    ? ["## Neighbourhood (strongest edges)", ...neighbourhood.map((e) => `- ${e.from} -> ${e.to}  ${e.kind} w${e.weight}${e.cite ? ` [${e.cite}]` : ""}`)].join(
        "\n",
      )
    : "";
  const tmpl = ["## Template", "```json", stableJson(template).trimEnd(), "```"].join("\n");
  const close = instructions({ id, file, reask, conflict });

  // The fixed parts always fit; the source fills what the budget leaves, whole excerpts first.
  const fixed = [head, cand.join("\n"), neigh, tmpl, close].filter(Boolean);
  const max = budget * CHARS_PER_TOKEN;
  let room = max - fixed.reduce((n, s) => n + s.length + 2, 0) - "## Source\n".length;
  const all = collectEvidence(repo, candidates, found.files);
  const evidence: LensEvidence[] = [];
  for (const e of all) {
    if (e.text.length + 2 > room) break;
    evidence.push(e);
    room -= e.text.length + 2;
  }
  const source = ["## Source", ...evidence.map((e) => e.text)];
  if (evidence.length < all.length)
    source.push(`… (cut to the ~${budget}-token budget: ${all.length - evidence.length} more excerpt(s); pass --budget to see more)`);
  if (!all.length) source.push("(no readable source matched)");
  const text = `${[head, cand.join("\n"), neigh, source.join("\n\n"), tmpl, close].filter(Boolean).join("\n\n")}\n`;

  return {
    question: q,
    id,
    file,
    reask,
    ...(conflict !== undefined ? { conflict } : {}),
    terms,
    template,
    candidates,
    capabilities,
    neighbourhood,
    evidence,
    budget,
    text,
  };
}

export interface LensListEntry {
  id: string;
  question: string;
  nodes: number;
  stale: boolean;
  /** Whether `lens save` stamped it (`sources` present). */
  stamped: boolean;
  /** When the lens file was last written (ISO-8601, from the file system). */
  saved?: string;
}

export interface LensList {
  repo: string;
  lenses: LensListEntry[];
  /** Lens files left out because they are invalid (run `check`). */
  invalid: { file: string; message: string }[];
}

/** Every saved lens with its stale flag, as `check` sees it. */
export function lensList(repoArg: string): LensList {
  const repo = resolve(repoArg);
  const live = liveView(repo);
  const stale = new Set(live.view.stale.lenses);
  const lenses = live.view.lenses.map((l) => {
    let saved: string | undefined;
    try {
      saved = statSync(join(repo, LENSES_DIR, `${l.id}.json`)).mtime.toISOString();
    } catch {
      saved = undefined;
    }
    return { id: l.id, question: l.question, nodes: l.nodes.length, stale: stale.has(l.id), stamped: !!l.sources, ...(saved ? { saved } : {}) };
  });
  const invalid = live.loaded.problems
    .filter((p) => p.file.startsWith(`${LENSES_DIR}/`))
    .map((p) => ({ file: p.file, message: `${p.path ? `${p.path}: ` : ""}${p.message}` }));
  return { repo, lenses, invalid };
}

export function formatLensList(r: LensList): string {
  if (!r.lenses.length && !r.invalid.length) return 'lenses     none saved yet: `ultraview lens new "<question>"` starts one\n';
  const lines = [`lenses     ${r.lenses.length} saved${r.lenses.some((l) => l.stale) ? `, ${r.lenses.filter((l) => l.stale).length} stale` : ""}`];
  for (const l of r.lenses) {
    const flags = [l.stale ? "STALE" : "", l.stamped ? "" : "unstamped"].filter(Boolean).join(", ");
    lines.push(`  ${l.id}  ${l.nodes} node(s)${l.saved ? `  saved ${l.saved.slice(0, 10)}` : ""}${flags ? `  [${flags}]` : ""}`);
    lines.push(`    ${l.question}`);
  }
  if (r.invalid.length) {
    lines.push("invalid (left out of the map; run `ultraview check`)");
    for (const p of r.invalid) lines.push(`  ${p.file}: ${p.message}`);
  }
  if (r.lenses.some((l) => l.stale))
    lines.push("next step: re-ask the stale ones (`ultraview lens new` with the same question keeps the id), then `ultraview lens save`");
  return `${lines.join("\n")}\n`;
}
