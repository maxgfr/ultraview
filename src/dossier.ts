// `ultraview dossier <node-id>`, as a library call (docs/design.md §7): the
// evidence pack the agent reads before writing about one node — real source,
// facts with file:line, and neighbours — so what it writes can cite.
//
//   mod                 ultraindex's module dossier + the module's facts
//   cap / sys           members, facts, neighbours, then the top files by
//                       PageRank (exports + head of each)
//   anything else       the defining excerpt, the sites that use it, neighbours
//
// Plain text, deterministic, cut to a token budget (≈ 4 characters a token).

import { join, resolve } from "node:path";
import { codeindex, gatherEvidence, renderModuleDossier } from "./engine.js";
import type { Facts } from "./extract/types.js";
import { fileId, fileOfId, kindOf, parseId } from "./model/ids.js";
import type { ViewEdge, ViewNode } from "./model/types.js";
import { type LiveView, liveView } from "./show.js";

/** Default budget, in tokens. */
export const DOSSIER_BUDGET = 6000;
const CHARS_PER_TOKEN = 4;
const KEY_FILES = 8;
const HEAD_LINES = 60;
const NEIGHBOURS = 12;
const FACTS_PER_KIND = 25;
const SITES = 12;

export interface DossierOptions {
  /** Token budget (default DOSSIER_BUDGET). */
  budget?: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const CITE_RULE =
  "Every sentence you write cites the file it rests on as `[path:line]` (or `[path:start-end]`); `ultraview check` fails a dead citation and an uncited sentence.";

function readLines(repo: string, rel: string): string[] | undefined {
  try {
    return codeindex.readText(join(repo, rel)).split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** Numbered lines [from, to] of a file (1-based, clamped). */
function excerpt(repo: string, rel: string, from: number, to: number): string | undefined {
  const lines = readLines(repo, rel);
  if (!lines) return undefined;
  const a = Math.max(1, from);
  const b = Math.min(lines.length, to);
  if (a > b) return undefined;
  const width = String(b).length;
  return lines
    .slice(a - 1, b)
    .map((l, i) => `${String(a + i).padStart(width)}  ${l}`)
    .join("\n");
}

function atParts(at: string | undefined): { file: string; line: number } | undefined {
  if (!at) return undefined;
  const i = at.lastIndexOf(":");
  return i > 0 ? { file: at.slice(0, i), line: Number(at.slice(i + 1)) } : undefined;
}

/** Sections in priority order; the budget keeps whole sections first, then cuts the first that overflows at a line. */
function withinBudget(sections: string[], budget: number): string {
  const max = budget * CHARS_PER_TOKEN;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (used + s.length + 2 <= max) {
      out.push(s);
      used += s.length + 2;
      continue;
    }
    const room = max - used;
    const nl = room > 0 ? s.lastIndexOf("\n", room) : -1;
    if (nl > 0) {
      let kept = s.slice(0, nl);
      if ((kept.match(/```/g)?.length ?? 0) % 2 === 1) kept += "\n```";
      out.push(kept);
    }
    out.push(`… (cut to the ~${budget}-token budget: ${sections.length - i - (nl > 0 ? 1 : 0)} more section(s); pass --budget to see more)`);
    break;
  }
  return `${out.join("\n\n")}\n`;
}

function neighbourLines(live: LiveView, id: string, leafOnly = false): string[] {
  const label = (x: string) => live.byId.get(x)?.label ?? x;
  const coarse = new Set(["cap", "sys", "mod"]);
  const keep = (other: string) => !leafOnly || !coarse.has(kindOf(other) ?? "");
  const byW = (key: "from" | "to") => (a: ViewEdge, b: ViewEdge) => b.weight - a.weight || cmp(a[key], b[key]) || cmp(a.kind, b.kind);
  const outs = live.view.edges.filter((e) => e.from === id && keep(e.to)).sort(byW("to"));
  const ins = live.view.edges.filter((e) => e.to === id && keep(e.from)).sort(byW("from"));
  const lines: string[] = [];
  for (const e of outs.slice(0, NEIGHBOURS)) lines.push(`- -> ${e.to} (${label(e.to)})  ${e.kind} w${e.weight}${e.cite ? ` [${e.cite}]` : ""}`);
  if (outs.length > NEIGHBOURS) lines.push(`- … and ${outs.length - NEIGHBOURS} more outgoing`);
  for (const e of ins.slice(0, NEIGHBOURS)) lines.push(`- <- ${e.from} (${label(e.from)})  ${e.kind} w${e.weight}${e.cite ? ` [${e.cite}]` : ""}`);
  if (ins.length > NEIGHBOURS) lines.push(`- … and ${ins.length - NEIGHBOURS} more incoming`);
  return lines.length ? ["## Neighbours", ...lines] : [];
}

/** Facts of the given nodes (routes, screens, entities, jobs, externals, infra), each with file:line. */
function factLines(nodes: ViewNode[]): string[] {
  const order = [
    ["route", "routes"],
    ["screen", "screens"],
    ["entity", "entities"],
    ["job", "jobs"],
    ["ext", "externals"],
    ["infra", "infra"],
  ] as const;
  const lines: string[] = [];
  for (const [kind, plural] of order) {
    const of = nodes.filter((n) => n.kind === kind).sort((a, b) => cmp(a.id, b.id));
    if (!of.length) continue;
    lines.push(`${plural} (${of.length}):`);
    for (const n of of.slice(0, FACTS_PER_KIND)) lines.push(`- ${n.id}${n.tags.length ? ` (${n.tags.join(", ")})` : ""}${n.at ? `  [${n.at}]` : ""}`);
    if (of.length > FACTS_PER_KIND) lines.push(`- … and ${of.length - FACTS_PER_KIND} more`);
  }
  return lines.length ? ["## Facts", ...lines] : [];
}

function evidenceBlocks(repo: string, rels: string[]): string[] {
  return gatherEvidence(repo, rels, HEAD_LINES).map((e) => {
    const parts = [`### ${e.rel} (${e.lines} lines)`];
    if (e.exported.length) {
      parts.push("Exported:");
      for (const s of e.exported) parts.push(`- ${s.kind} ${s.name} @ line ${s.line}`);
    }
    parts.push(`Source (lines 1-${e.headTo}${e.headTo < e.lines ? ", file continues" : ""}):`, "```", excerpt(repo, e.rel, 1, e.headTo) ?? e.head, "```");
    return parts.join("\n");
  });
}

function header(n: ViewNode, task: string): string {
  const lines = [`# Dossier — ${n.id}  "${n.label}"`, "", `Task: ${task} ${CITE_RULE}`];
  if (n.summary) lines.push("", `Current summary: ${n.summary.replace(/\s+/g, " ")}`);
  const meta = [n.parent ? `parent ${n.parent}` : "", n.caps.length ? `caps ${n.caps.join(", ")}` : "", n.at ? `defined at ${n.at}` : ""].filter(Boolean);
  if (meta.length) lines.push("", meta.join(" · "));
  return lines.join("\n");
}

/** The files worth reading for a group: non-test, non-doc; code first, then by PageRank. */
function topFiles(files: ViewNode[]): string[] {
  const isCode = (f: ViewNode) => (f.tags.includes("code") ? 0 : 1);
  return files
    .filter((f) => !f.tags.includes("test") && !f.tags.includes("doc"))
    .sort((a, b) => isCode(a) - isCode(b) || b.metrics.pagerank - a.metrics.pagerank || cmp(a.id, b.id))
    .slice(0, KEY_FILES)
    .map((f) => fileOfId(f.id)!);
}

function groupDossier(live: LiveView, repo: string, n: ViewNode, budget: number): string {
  const nodes = live.view.nodes;
  let members: ViewNode[];
  if (n.kind === "cap") members = nodes.filter((x) => x.caps.includes(n.id));
  else {
    const under = new Set<string>([n.id]);
    // Nodes are sorted by id, not by depth: iterate to a fixpoint.
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of nodes) {
        if (x.parent && under.has(x.parent) && !under.has(x.id)) {
          under.add(x.id);
          grew = true;
        }
      }
    }
    under.delete(n.id);
    // A system also owns the files its globs matched, wherever the module vote put them.
    for (const [rel, sys] of live.fileSystems) if (sys === n.id) under.add(fileId(rel));
    members = nodes.filter((x) => under.has(x.id));
  }
  const files = members.filter((x) => x.kind === "file");
  const fileSet = new Set(files.map((f) => f.id));
  // Externals reached from the member files.
  const exts = new Set(live.view.edges.filter((e) => fileSet.has(e.from) && kindOf(e.to) === "ext").map((e) => e.to));
  const factNodes = [...members, ...[...exts].map((x) => live.byId.get(x)!)].filter((x) => x && x.kind !== "file" && x.kind !== "sym" && x.kind !== "mod");

  const mods = members.filter((x) => x.kind === "mod").sort((a, b) => b.metrics.pagerank - a.metrics.pagerank || cmp(a.id, b.id));
  const modLines = mods.map(
    (m) => `- ${m.id} (${m.label}): ${nodes.filter((x) => x.parent === m.id && x.kind === "file").length} file(s), pagerank ${m.metrics.pagerank}`,
  );
  const memberSection = [
    `## Members: ${mods.length} module(s), ${files.length} file(s)`,
    ...(modLines.length ? modLines : files.slice(0, 20).map((f) => `- ${f.id}`)),
  ].join("\n");

  const task =
    n.kind === "cap"
      ? `write this capability's \`summary\` in .ultraview/model.json: what it does for the people using the app, in plain words, from the evidence below.`
      : `write this system's \`summary\` in .ultraview/model.json: what it is and what it does for the app, in plain words, from the evidence below.`;
  const sections = [header(n, task), memberSection];
  const facts = factLines(factNodes);
  if (facts.length) sections.push(facts.join("\n"));
  const neigh = neighbourLines(live, n.id);
  if (neigh.length) sections.push(neigh.join("\n"));
  const key = topFiles(files);
  if (key.length) sections.push(`## Key source (top ${key.length} file(s) by PageRank)`, ...evidenceBlocks(repo, key));
  return withinBudget(sections, budget);
}

/** Usage sites of a detected node, from the facts, each `file:line (what)`. */
function sitesOf(facts: Facts, n: ViewNode): { file: string; line: number; what: string }[] {
  const p = parseId(n.id);
  if (!p) return [];
  switch (p.kind) {
    case "route":
      return facts.calls.filter((c) => c.route === n.id).map((c) => ({ file: c.file, line: c.line, what: `${c.method} ${c.url}` }));
    case "entity":
      return facts.entityUses.filter((u) => u.entity === p.name).map((u) => ({ file: u.file, line: u.line, what: u.op }));
    case "ext":
      return facts.externals.filter((x) => x.id === p.name).map((x) => ({ file: x.file, line: x.line, what: `via ${x.via}` }));
    case "job":
      return facts.jobs.filter((j) => j.id === p.name).map((j) => ({ file: j.file, line: j.line, what: j.kind }));
    default:
      return [];
  }
}

function leafDossier(live: LiveView, repo: string, n: ViewNode, budget: number): string {
  const sections = [
    header(n, `explain what \`${n.id}\` does and who relies on it, from the evidence below (a flow step, a lens answer or a capability summary).`),
  ];
  const at = atParts(n.at);
  if (n.kind === "file") {
    sections.push(...evidenceBlocks(repo, [fileOfId(n.id)!]));
  } else if (at) {
    const end = n.metrics.loc > 0 ? at.line + n.metrics.loc - 1 : at.line + 15;
    const ex = excerpt(repo, at.file, at.line - 3, Math.min(end + 2, at.line + 60));
    if (ex) sections.push(`## Definition [${n.at}]\n\`\`\`\n${ex}\n\`\`\``);
  }
  if (n.fields?.length)
    sections.push(["## Fields", ...n.fields.map((f) => `- ${f.name}: ${f.type}${f.relation ? ` -> entity:${f.relation}` : ""}`)].join("\n"));
  const sites = sitesOf(live.loaded.inputs.facts, n).sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
  const neigh = neighbourLines(live, n.id, true);
  if (neigh.length) sections.push(neigh.join("\n"));
  if (sites.length) {
    sections.push(`## Used at (${sites.length} site(s))`);
    for (const s of sites.slice(0, SITES)) {
      const ex = excerpt(repo, s.file, s.line - 2, s.line + 3);
      sections.push(`### [${s.file}:${s.line}] ${s.what}${ex ? `\n\`\`\`\n${ex}\n\`\`\`` : ""}`);
    }
    if (sites.length > SITES) sections.push(`… and ${sites.length - SITES} more site(s)`);
  }
  return withinBudget(sections, budget);
}

/** The dossier text for `id`, or undefined when the id is unknown. */
export function renderNodeDossier(live: LiveView, repo: string, id: string, opts: DossierOptions = {}): string | undefined {
  const n = live.byId.get(id);
  if (!n) return undefined;
  const budget = opts.budget ?? DOSSIER_BUDGET;
  if (n.kind === "mod") {
    const slug = id.slice("mod:".length);
    const module = live.loaded.inputs.graph.modules.find((m) => m.slug === slug);
    if (!module) return undefined;
    // The engine's dossier first (its own budget), then what ultraview adds.
    const base = renderModuleDossier(repo, live.loaded.inputs.graph, module, budget).trimEnd();
    const under = live.view.nodes.filter((x) => x.parent && (x.parent === id || live.byId.get(x.parent)?.parent === id));
    const facts = factLines(under);
    const extra = [`## ultraview`, `node ${id} · parent ${n.parent ?? "-"} · caps ${n.caps.join(", ") || "(none)"}`, ...facts].join("\n");
    return `${base}\n\n${extra}\n`;
  }
  if (n.kind === "cap" || n.kind === "sys") return groupDossier(live, repo, n, budget);
  return leafDossier(live, repo, n, budget);
}

/** Load the live view of `repo` and render the dossier for `id`. */
export function nodeDossier(repoArg: string, id: string, opts: DossierOptions = {}): { text?: string; live: LiveView } {
  const repo = resolve(repoArg);
  const live = liveView(repo);
  return { text: renderNodeDossier(live, repo, id, opts), live };
}
