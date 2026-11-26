// `ultraview lens new "<question>"` and `lens list`, as library calls
// (docs/design.md §7, §9 step 3).
//
//   lens new    the evidence pack the agent reads before answering a question:
//               a proposed id (slug of the question; for one in another
//               script, of its --terms, else `lens-<hash>`; de-duplicated
//               against the saved lenses), the target path, the JSON template, ranked
//               candidate nodes (ultraindex `runFind` over modules, mapped to
//               view node ids, slices included; before them, the routes /
//               screens / entities / jobs / symbols / capabilities named like
//               the question, ranked by `nameMatches`; the question is read
//               through `lens-terms.ts`, with the English `--terms` the agent
//               supplies for a question in another language), their
//               strongest edges, source excerpts (ultraindex
//               `gatherEvidence`) cut to a budget, and the closing instructions.
//   lens list   every saved lens: id, question, node count, stale flag (the
//               assembler's own staleness: a cited file's hash changed), and
//               when its file was last written.
//
// With `--thread <id>` (a conversation, src/chat.ts) the pack is for the
// thread's next turn: it opens with the thread's digest (chatDigest: earlier
// questions, one-line answers, node ids in play, within DIGEST_BUDGET tokens),
// and the ranking folds in the nodes the earlier turns were about, so a
// follow-up with no content words ("and who calls it?") still ranks them and
// their neighbours first; the template is a turn's and the target the
// thread's draft. `--context` (what was clicked in the map) seeds the ranking
// the same way, stronger. Without either, the pack is unchanged.
//
// Read-only: neither writes anything. Deterministic: the same index, view,
// question (and thread) give the same pack, byte for byte.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chatDigest, type ContextView, DIGEST_TURNS, draftFile, inPlay, loadConversation, resolveContext, turnNodes } from "./chat.js";
import { codeindex, gatherEvidence, runFind } from "./engine.js";
import { extentFinder } from "./extract/extent.js";
import { stableJson } from "./json.js";
import { guessLang, type QuestionReading, questionId, readQuestion, verbMethods } from "./lens-terms.js";
import { fileOfId, modId, SLUG_RE } from "./model/ids.js";
import { LENSES_DIR } from "./model/load.js";
import { CITATION_RULE } from "./model/prose.js";
import type { ChatContext, ChatMode, Conversation, ViewEdge, ViewNode } from "./model/types.js";
import { viewPaths } from "./paths.js";
import { carriedOver } from "./refresh.js";
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
  /** English code keywords for the question (`--terms`): required of the agent when the question is not in English. */
  terms?: string;
  /** A conversation id (`--thread`): the pack is for its next turn. */
  thread?: string;
  /** What the question is about in the map (`--context`): a node, an edge, an insight, a flow step. */
  context?: ChatContext;
}

export interface LensCandidate {
  id: string;
  kind: ViewNode["kind"];
  label: string;
  /** Where it is defined (`path:line`), for a detected node. */
  at?: string;
  /** Why it is a candidate: `find` (ultraindex module ranking), `name` (its name matches the question) or `thread` (only the conversation, or the context, points at it). */
  via: "find" | "name" | "thread";
  /** find: ultraindex's score; name: the rank score (rarer terms weigh more, a term in the name more than one in the body, plus the kind / method / capability bonuses). */
  score: number;
  /** The question terms it matched. */
  matched: string[];
  /** With a thread or a context: what they added to the score. */
  thread?: number;
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

/** The template of a conversation turn: a lens answer plus the turn's own fields. */
export interface TurnTemplate {
  question: string;
  answer: string;
  nodes: string[];
  edges: { from: string; to: string }[];
  focus: string;
  lang: string;
  mode: ChatMode;
  followUps: string[];
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
  /** The question is not English (lens-terms `isBridged`): its words were bridged to English, by `--terms` or, without them, the French lexicon. */
  bridged: boolean;
  /** The `--terms` given, trimmed (absent without them). */
  suppliedTerms?: string;
  template: LensTemplate | TurnTemplate;
  /** `--thread`: the conversation, its digest and the weight each earlier node got in the ranking. */
  thread?: { id: string; turns: number; digest: string; inPlay: string[]; seeds: { id: string; weight: number }[] };
  /** `--context`: what it named and the nodes it points at. */
  context?: { value: ChatContext; nodes: string[] };
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

/**
 * The slug of a question (lens-terms `questionId`): folded to ASCII,
 * lowercase, words joined by `-`, cut at a word under ID_MAX; for a question
 * whose slug is empty or too short (another script), the slug of the English
 * `terms`, else `lens-<hash>`.
 */
export function questionSlug(question: string, terms?: string): string {
  return questionId(question, { prefix: "lens", max: ID_MAX, terms });
}

/**
 * The id a new lens for `question` gets: its slug (`questionSlug`, with the
 * `--terms` when given); when a saved lens already holds that slug for a
 * DIFFERENT question, `<slug>-2`, `-3`… A question some saved lens already
 * holds keeps that lens's id (asking again replaces the answer, as `lens save`
 * allows).
 */
export function proposeLensId(repo: string, question: string, terms?: string): { id: string; reask: boolean } {
  const saved = savedQuestions(resolve(repo));
  for (const [id, q] of saved) if (q === question) return { id, reask: true };
  const base = questionSlug(question, terms);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!saved.has(id)) return { id, reask: false };
  }
}

/** Question terms, stemmed (`cancelling` → `cancel`, `orders` → `order`), merged with the supplied English `terms`; a French question's words bridged to English (`commande` → `order`) when no terms are given. */
export function questionTerms(question: string, terms?: string): string[] {
  return readQuestion(question, terms).terms;
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
/**
 * Thread and context seeds (lens new --thread / --context). A seed is a node
 * an earlier turn was about (its answer's nodes, focus and context), weighing
 * THREAD_DECAY^(d-1) for the turn d back (the last one 1), shared by the
 * square root of that turn's node count; or a node the current question was
 * asked about, CONTEXT_WEIGHT. The last DIGEST_TURNS turns count. A pool node relates to a
 * seed by the strongest of: being it — SELF; an edge with it or a mention (one's
 * name in the other's definition: a call, a data access; an entity is also
 * reached through a relation field of a mentioned one, `order.items` →
 * OrderItem, the way ORMs write nested data) — 1; the same
 * defining file — SIBLING; a file-level edge between their files, or from
 * one's file to the other — LINKED. Its thread score is the sum over the
 * seeds of weight × relation, times THREAD_WEIGHT, added to its name score; a
 * node no term matched but the thread points at is a candidate too (`via:
 * "thread"`), with the kind, method and cardinality bonuses of the wording.
 */
const THREAD_DECAY = 0.5;
const CONTEXT_WEIGHT = 2;
const THREAD_WEIGHT = 1.5;
const SELF = 1.5;
const SIBLING = 0.5;
const LINKED = 0.4;
/** Shortest name a mention is looked for (shorter ones match by accident). */
const MENTION_MIN = 4;

/** The words of `text` as the engine splits them (any script; `orderItems` → `orderitems`, `order`, `items`), folded and lowercased. */
const lowerTokens = (text: string): string[] => {
  const out = new Set<string>();
  for (const raw of codeindex.keywords(text, () => true)) for (const t of codeindex.subtokens(raw)) out.add(codeindex.foldText(t).toLowerCase());
  return [...out];
};

interface Hay {
  tokens: string[];
  whole: string;
}

const hay = (text: string): Hay => ({ tokens: lowerTokens(text), whole: codeindex.foldText(text).toLowerCase() });

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
function nameMatches(repo: string, view: LiveView["view"], q: QuestionReading, seeds: ReadonlyMap<string, number> = new Map()): LensCandidate[] {
  if (!q.terms.length && !seeds.size) return [];
  const files = new Map<string, string | undefined>();
  const pool = view.nodes
    .filter((n) => NAME_KINDS.has(n.kind) && n.id !== "cap:_foundations")
    .map((n) => ({ n, name: hay(`${n.label} ${n.id.slice(n.kind.length + 1)}`), detail: hay(detailText(repo, n, files)) }));
  const threadScore = seeds.size ? threadScores(repo, view, pool, seeds, files) : new Map<string, number>();
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
    const t = threadScore.get(n.id) ?? 0;
    const b = base.get(n.id) ?? (t > 0 ? { score: 0, matched: [] } : undefined);
    if (!b) continue;
    let score = b.score + t;
    if (q.kinds.has(n.kind)) score += KIND_BONUS;
    // A symbol whose name starts with the verb the wording points at (`buy` → POST → `placeOrder`).
    if (n.kind === "sym" && verbMethods(n.label).some((m) => q.methods.has(m))) score += METHOD_BONUS;
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
      via: b.matched.length ? "name" : "thread",
      score: Math.round(score * 1000) / 1000,
      matched: b.matched,
      ...(t > 0 ? { thread: Math.round(t * 1000) / 1000 } : {}),
    });
  }
  return out.sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cmp(a.id, b.id)).slice(0, MATCHES);
}

/** The file a node is defined in (or is), when it has one. */
function fileOfNode(n: ViewNode): string | undefined {
  if (n.kind === "file") return n.id.slice("file:".length);
  if (n.at && n.kind !== "cap") return n.at.slice(0, n.at.lastIndexOf(":"));
  return fileOfId(n.id);
}

/** Each pool node's thread score: Σ over the seeds of weight × relation (see THREAD_DECAY), × THREAD_WEIGHT. */
function threadScores(
  repo: string,
  view: LiveView["view"],
  pool: { n: ViewNode; detail: Hay }[],
  seeds: ReadonlyMap<string, number>,
  files: Map<string, string | undefined>,
): Map<string, number> {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const edges = new Set<string>();
  const fileLinks = new Set<string>();
  for (const e of view.edges) {
    edges.add(`${e.from}\u0000${e.to}`);
    edges.add(`${e.to}\u0000${e.from}`);
    if (e.from.startsWith("file:")) fileLinks.add(`${e.from.slice(5)}\u0000${e.to.startsWith("file:") ? e.to.slice(5) : e.to}`);
    if (e.to.startsWith("file:")) fileLinks.add(`${e.to.slice(5)}\u0000${e.from.startsWith("file:") ? e.from.slice(5) : e.from}`);
  }
  const detailOf = new Map(pool.map((p) => [p.n.id, p.detail]));
  const entities = view.nodes
    .filter((n) => n.kind === "entity")
    .map((n) => ({
      id: n.id,
      name: codeindex.foldText(n.label).toLowerCase(),
      relations: (n.fields ?? [])
        .filter((f) => f.relation && byId.has(`entity:${f.relation}`) && f.name.length >= MENTION_MIN)
        .map((f) => ({ field: codeindex.foldText(f.name).toLowerCase(), to: `entity:${f.relation}` })),
    }));
  /** The entities a definition reaches: those it names, and through their relation fields it names, the related ones. */
  const reached = (tokens: ReadonlySet<string>): Set<string> => {
    const out = new Set<string>();
    for (const e of entities) {
      if (e.name.length < MENTION_MIN || !tokens.has(e.name)) continue;
      out.add(e.id);
      for (const r of e.relations) if (tokens.has(r.field)) out.add(r.to);
    }
    return out;
  };
  const seedInfo = [...seeds]
    .map(([id, weight]) => {
      const n = byId.get(id);
      if (!n) return undefined;
      const detail = detailOf.get(id) ?? hay(detailText(repo, n, files));
      const tokens = new Set(detail.tokens);
      return { id, weight, n, file: fileOfNode(n), name: codeindex.foldText(n.label).toLowerCase(), tokens, reached: reached(tokens) };
    })
    .filter((x) => x !== undefined);
  const out = new Map<string, number>();
  for (const { n, detail } of pool) {
    const file = fileOfNode(n);
    const name = codeindex.foldText(n.label).toLowerCase();
    const tokens = new Set(detail.tokens);
    const reaches = reached(tokens);
    let sum = 0;
    for (const s of seedInfo) {
      let rel = 0;
      if (s.id === n.id) rel = SELF;
      else if (edges.has(`${n.id}\u0000${s.id}`)) rel = 1;
      else if (
        (s.name.length >= MENTION_MIN && tokens.has(s.name)) ||
        (name.length >= MENTION_MIN && s.tokens.has(name)) ||
        reaches.has(s.id) ||
        s.reached.has(n.id)
      )
        rel = 1;
      else if (file && s.file && file === s.file) rel = SIBLING;
      else if (
        (file && s.file && fileLinks.has(`${s.file}\u0000${file}`)) ||
        (s.file && fileLinks.has(`${s.file}\u0000${n.id}`)) ||
        (file && fileLinks.has(`${file}\u0000${s.id}`))
      )
        rel = LINKED;
      sum += s.weight * rel;
    }
    if (sum > 0) out.set(n.id, sum * THREAD_WEIGHT);
  }
  return out;
}

/** The seeds of a thread's next turn: what the current question is about, then the nodes of the earlier turns, most recent first. */
function threadSeeds(conv: Conversation | undefined, contextNodes: readonly string[], known: ReadonlyMap<string, ViewNode>): Map<string, number> {
  const seeds = new Map<string, number>();
  const add = (id: string, w: number) => {
    if (known.has(id) && w > (seeds.get(id) ?? 0)) seeds.set(id, w);
  };
  for (const id of contextNodes) add(id, CONTEXT_WEIGHT);
  const turns = [...(conv?.turns ?? [])].reverse().slice(0, DIGEST_TURNS);
  turns.forEach((t, d) => {
    // A turn's nodes share its weight (by the square root of their count): a long answer does not swamp a click.
    const ids = turnNodes(t).filter((id) => known.has(id));
    for (const id of ids) add(id, THREAD_DECAY ** d / Math.sqrt(ids.length));
  });
  return seeds;
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
  return `- ${c.id}  (${c.label})${c.at ? `  [${c.at}]` : ""}  score ${c.score}: ${c.matched.join(", ") || "-"}${c.thread ? `  (thread +${c.thread})` : ""}`;
}

/** The closing instructions: what to write, where, and the gates to run. */
function instructions(pack: Pick<LensPack, "id" | "file" | "reask" | "conflict">): string {
  const lines = [
    "## Next",
    `1. Answer the question from the evidence above (open more files if you need to); \`ultraview show <node-id>\` and \`ultraview dossier <node-id>\` give more about one node.`,
    "2. The citation rule for `answer` (`ultraview check` fails a dead citation and an uncited sentence):",
    ...CITATION_RULE.map((l) => `   ${l}`),
    "3. `nodes`: the node ids the answer is about (pick from the candidates, or any id `ultraview show` knows); `edges` (optional): the links between them that matter; `focus`: the one node to centre the map on.",
    `4. Write the JSON above, filled in, to ${pack.file}${pack.reask ? " (it already holds this question: the new answer replaces the old one)" : ""}. Leave \`sources\` out: \`lens save\` stamps it.`,
    `5. Run \`ultraview lens save ${pack.file}\`${pack.conflict ? " --force (the id holds a different question)" : ""}, then \`ultraview check\`, and fix what they report.`,
    `6. Point the user at \`#lens=${pack.id}\` in the map (live when \`ultraview serve\` runs).`,
  ];
  return lines.join("\n");
}

/** The closing instructions of a thread's next turn. */
function turnInstructions(pack: { thread: string; file: string }): string {
  return [
    "## Next",
    '1. Read the question with the conversation above: "it", "that", "this", "and then?" refer to the most recent turn\'s nodes ("In play") unless the question names something else; a question about something new is a new topic. `ultraview show <node-id>` and `ultraview dossier <node-id>` give more about one node.',
    "2. The citation rule for `answer` (`lens save --thread` refuses a dead citation, an uncited sentence and an unknown node id):",
    ...CITATION_RULE.map((l) => `   ${l}`),
    "3. Answer in the language of the question (`lang`: its BCP-47 tag, e.g. en, fr, ja; citations stay as they are). `mode` business: plain words for someone who does not read code, no function, file or symbol names unless the question asks for them; `mode` dev: the technical detail (symbols, calls, files, routes).",
    "4. `nodes`: the node ids the answer is about; `edges` (optional): the links that matter; `focus`: the one node to centre the map on.",
    "5. `followUps`: exactly 3 short questions the user could ask next about this app, in the question's language.",
    `6. Write the JSON above, filled in, to ${pack.file}, run \`ultraview lens save ${pack.file} --thread ${pack.thread}\` (it appends the turn), then \`ultraview check\`, and fix what they report.`,
    `7. Point the user at \`#chat=${pack.thread}\` in the map (live when \`ultraview serve\` runs).`,
  ].join("\n");
}

/** The pack for `question` over the live view of `repo`. */
export function lensNew(repoArg: string, question: string, opts: LensNewOptions = {}): LensPack {
  const repo = resolve(repoArg);
  const q = question.trim();
  if (!q) throw new Error("the question is empty");
  if (opts.id !== undefined && !SLUG_RE.test(opts.id)) throw new Error(`--id must be a slug (lowercase letters, digits, dashes): ${opts.id}`);
  if (opts.id !== undefined && opts.thread !== undefined) throw new Error("--id names a lens; a thread's turn has no id of its own: drop --id or --thread");
  const live = liveView(repo);
  const budget = opts.budget ?? LENS_BUDGET;

  const conv = opts.thread !== undefined ? loadConversation(repo, opts.thread) : undefined;
  let context: { value: ChatContext; nodes: string[]; lines: string[] } | undefined;
  if (opts.context && Object.keys(opts.context).length) {
    let viewText: string | undefined;
    try {
      viewText = readFileSync(viewPaths(repo).view, "utf8");
    } catch {
      viewText = undefined;
    }
    const cv: ContextView = { byId: live.byId, flows: live.view.flows, insights: carriedOver(viewText).insights ?? [] };
    const r = resolveContext(cv, opts.context);
    if ("error" in r) throw new Error(r.error);
    context = { value: opts.context, ...r };
  }
  const seeds = threadSeeds(conv, context?.nodes ?? [], live.byId);

  const supplied = opts.terms?.trim() || undefined;
  let id: string;
  let reask: boolean;
  let conflict: string | undefined;
  if (conv) {
    id = conv.id;
    reask = false;
  } else if (opts.id !== undefined) {
    id = opts.id;
    const saved = savedQuestions(repo);
    reask = saved.has(id) && saved.get(id) === q;
    if (saved.has(id) && !reask) conflict = saved.get(id) ?? "(unreadable file)";
  } else ({ id, reask } = proposeLensId(repo, q, supplied));
  const file = conv ? draftFile(conv.id) : `${LENSES_DIR}/${id}.json`;

  const reading = readQuestion(q, supplied);
  const terms = reading.terms;
  // ultraindex find reads the terms too; a bridged question's own words would only add noise to it.
  const found = findMatches(live, viewPaths(repo).index, supplied ? (reading.bridged ? supplied : `${q} ${supplied}`) : q);
  const named = nameMatches(repo, live.view, reading, seeds);
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
  const nodes = (named.some((c) => c.kind !== "cap") ? named.filter((c) => c.kind !== "cap") : candidates.filter((c) => c.kind !== "mod"))
    .slice(0, 5)
    .map((c) => c.id);
  const template: LensTemplate | TurnTemplate = conv
    ? {
        question: q,
        answer: "Markdown, in the question's language. Every sentence cites [path:line].",
        nodes,
        edges: [],
        focus,
        lang: guessLang(q),
        mode: conv.turns.at(-1)?.mode ?? (live.view.app.audience === "developers" ? "dev" : "business"),
        followUps: ["…", "…", "…"],
      }
    : { schema: 1, id, question: q, answer: "Markdown. Every sentence cites [path:line].", nodes, edges: [], focus };
  const digest = conv ? chatDigest(conv) : "";

  const head = [
    `# ${conv ? "Conversation turn" : "Lens"} evidence — "${q}"`,
    "",
    conv ? `thread    ${conv.id} (turn ${conv.turns.length + 1})` : `id        ${id}${reask ? "  (re-ask: a saved lens holds this question)" : ""}`,
    `file      ${file}`,
    ...(context ? [`about     ${context.lines.join("; ")}`] : []),
    ...(conflict !== undefined ? [`conflict  ${file} holds a different question ("${conflict}"): pick another --id, or save with --force`] : []),
    `terms     ${terms.join(", ") || "(none)"}`,
    ...(reading.bridged
      ? [
          supplied
            ? "reading   not English: read through --terms (the question's own words weigh less)"
            : 'reading   not English and no --terms: pass --terms "<English code keywords>" (the words the code would use) and run lens new again',
        ]
      : []),
  ].join("\n");
  const cand = ["## Candidate nodes"];
  const fromFind = candidates.filter((c) => c.via === "find");
  const fromName = candidates.filter((c) => c.via === "name");
  const fromThread = candidates.filter((c) => c.via === "thread");
  if (fromName.length) cand.push("Named like the question (routes, screens, entities, jobs, symbols, capabilities):", ...fromName.map(fmtCandidate));
  if (fromThread.length) cand.push(`Pointed at by the ${conv ? "conversation" : "context"} (no question word matched):`, ...fromThread.map(fmtCandidate));
  if (fromFind.length) cand.push("Modules (ultraindex find):", ...fromFind.map(fmtCandidate));
  if (!candidates.length) cand.push("(nothing matched: try other words, or `ultraview show` / `dossier` on a node you know)");
  if (capabilities.length) cand.push(`Capabilities touched: ${capabilities.map((c) => `${c.id} (${c.label})`).join(", ")}`);
  const neigh = neighbourhood.length
    ? ["## Neighbourhood (strongest edges)", ...neighbourhood.map((e) => `- ${e.from} -> ${e.to}  ${e.kind} w${e.weight}${e.cite ? ` [${e.cite}]` : ""}`)].join(
        "\n",
      )
    : "";
  const tmpl = ["## Template", "```json", stableJson(template).trimEnd(), "```"].join("\n");
  const close = conv ? turnInstructions({ thread: conv.id, file }) : instructions({ id, file, reask, conflict });

  // The fixed parts always fit; the source fills what the budget leaves, whole excerpts first.
  const fixed = [head, digest, cand.join("\n"), neigh, tmpl, close].filter(Boolean);
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
  const text = `${[head, digest, cand.join("\n"), neigh, source.join("\n\n"), tmpl, close].filter(Boolean).join("\n\n")}\n`;

  return {
    question: q,
    id,
    file,
    reask,
    ...(conflict !== undefined ? { conflict } : {}),
    terms,
    bridged: reading.bridged,
    ...(supplied ? { suppliedTerms: supplied } : {}),
    template,
    ...(conv
      ? {
          thread: {
            id: conv.id,
            turns: conv.turns.length,
            digest,
            inPlay: inPlay(conv),
            seeds: [...seeds].map(([sid, weight]) => ({ id: sid, weight })).sort((a, b) => b.weight - a.weight || cmp(a.id, b.id)),
          },
        }
      : {}),
    ...(context ? { context: { value: context.value, nodes: context.nodes } } : {}),
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
