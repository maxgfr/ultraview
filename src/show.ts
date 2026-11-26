// `ultraview show <node-id>`, as a library call (docs/design.md §7): a compact
// card for one node — what it is, where it sits, what it serves, its strongest
// edges — so the agent never opens view.json.
//
// The view is assembled live from the current files (not read back from
// view.json), so a model edit shows up without a rebuild.

import { resolve } from "node:path";
import { type AssembleResult, assembleWithNotes } from "./model/assemble.js";
import { UNASSIGNED_SYS } from "./model/ids.js";
import { type LoadedInputs, loadViewInputs } from "./model/load.js";
import type { NodeMetrics, ViewEdge, ViewModel, ViewNode } from "./model/types.js";

/** Edges listed per direction. */
export const CARD_EDGES = 10;
/** Children / members listed by id. */
export const CARD_LIST = 20;

export interface LiveView extends AssembleResult {
  loaded: LoadedInputs;
  byId: Map<string, ViewNode>;
}

/** Load and assemble the view of `repo` as its files stand now. */
export function liveView(repo: string): LiveView {
  const loaded = loadViewInputs(resolve(repo));
  const assembled = assembleWithNotes(loaded.inputs);
  return { ...assembled, loaded, byId: new Map(assembled.view.nodes.map((n) => [n.id, n])) };
}

export interface NodeList {
  total: number;
  byKind: Record<string, number>;
  /** The first CARD_LIST ids, sorted. */
  first: string[];
}

export interface NodeCard {
  id: string;
  kind: ViewNode["kind"];
  label: string;
  parent?: string;
  summary?: string;
  cites: string[];
  at?: string;
  caps: string[];
  tags: string[];
  metrics: NodeMetrics;
  role?: string;
  actors?: string[];
  fields?: ViewNode["fields"];
  /** mod slice: the module it is part of and the system it sits in. */
  slice?: ViewNode["slice"];
  /** mod: its other slices, one per further system its files sit in. */
  slices?: string[];
  /** Structural children. */
  children: NodeList;
  /** cap: the nodes serving it. */
  members?: NodeList;
  /** sys:_unassigned: code files no system's globs match. */
  unassignedFiles?: string[];
  edges: { in: number; out: number };
  /** Top edges by weight (ties by id). */
  out: ViewEdge[];
  in: ViewEdge[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function listOf(nodes: ViewNode[]): NodeList {
  const byKind: Record<string, number> = {};
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const ids = nodes.map((n) => n.id).sort(cmp);
  return { total: ids.length, byKind, first: ids.slice(0, CARD_LIST) };
}

const byWeight = (key: "from" | "to") => (a: ViewEdge, b: ViewEdge) => b.weight - a.weight || cmp(a[key], b[key]) || cmp(a.kind, b.kind);

/** Card for one node; undefined when the id is unknown. */
export function nodeCard(live: Pick<LiveView, "view" | "byId" | "fileSystems">, id: string): NodeCard | undefined {
  const node = live.byId.get(id);
  if (!node) return undefined;
  const { view } = live;
  const outs = view.edges.filter((e) => e.from === id);
  const ins = view.edges.filter((e) => e.to === id);
  const card: NodeCard = {
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.parent ? { parent: node.parent } : {}),
    ...(node.summary ? { summary: node.summary } : {}),
    cites: node.cites,
    ...(node.at ? { at: node.at } : {}),
    caps: node.caps,
    tags: node.tags,
    metrics: node.metrics,
    ...(node.role ? { role: node.role } : {}),
    ...(node.actors ? { actors: node.actors } : {}),
    ...(node.fields ? { fields: node.fields } : {}),
    ...(node.slice ? { slice: node.slice } : {}),
    children: listOf(view.nodes.filter((n) => n.parent === id)),
    edges: { in: ins.length, out: outs.length },
    out: [...outs].sort(byWeight("to")).slice(0, CARD_EDGES),
    in: [...ins].sort(byWeight("from")).slice(0, CARD_EDGES),
  };
  if (node.kind === "mod" && !node.slice) {
    const slices = view.nodes.filter((n) => n.slice?.of === id).map((n) => n.id);
    if (slices.length) card.slices = slices;
  }
  if (node.kind === "cap") {
    const serving = view.nodes.filter((n) => n.caps.includes(id));
    // Business-level members first: the ids an agent writes into `members`.
    const coarse = serving.filter((n) => n.kind !== "file" && n.kind !== "sym");
    card.members = { ...listOf(serving), first: listOf(coarse.length ? coarse : serving).first };
  }
  if (id === UNASSIGNED_SYS) {
    const codeFiles = new Set(view.nodes.filter((n) => n.kind === "file" && n.tags.includes("code")).map((n) => n.id.slice("file:".length)));
    card.unassignedFiles = [...live.fileSystems]
      .filter(([rel, sys]) => sys === UNASSIGNED_SYS && codeFiles.has(rel))
      .map(([rel]) => rel)
      .sort(cmp);
  }
  return card;
}

/** Ids that look like `query` (substring match on id or label), for an unknown-id error. */
export function similarIds(view: ViewModel, query: string, n = 5): string[] {
  const q = query.toLowerCase().replace(/^[a-z]+:/, "");
  if (!q) return [];
  return view.nodes
    .filter((x) => x.id.toLowerCase().includes(q) || x.label.toLowerCase().includes(q))
    .map((x) => x.id)
    .sort((a, b) => a.length - b.length || cmp(a, b))
    .slice(0, n);
}

function fmtList(l: NodeList): string {
  const kinds = Object.entries(l.byKind)
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  return `${l.total}${kinds ? ` (${kinds})` : ""}`;
}

function fmtEdge(e: ViewEdge, other: string, arrow: string): string {
  return `  ${arrow} ${other}  ${e.kind} w${e.weight}${e.derived ? "" : " (model)"}${e.label ? `  "${e.label}"` : ""}${e.cite ? `  [${e.cite}]` : ""}`;
}

export function formatNodeCard(c: NodeCard): string {
  const lines: string[] = [`${c.id}  (${c.kind}${c.role ? `, ${c.role}` : ""})  ${c.label}`];
  const row = (k: string, v: string) => lines.push(`${k.padEnd(9)} ${v}`);
  if (c.summary) row("summary", c.summary.replace(/\s+/g, " "));
  if (c.at) row("at", c.at);
  if (c.cites.length) row("cites", c.cites.join(", "));
  row("parent", c.parent ?? "(top level)");
  if (c.slice) row("slice of", `${c.slice.of} ${c.slice.qualifier}`);
  if (c.slices) row("slices", c.slices.join(", "));
  if (c.kind !== "cap") row("caps", c.caps.length ? c.caps.join(", ") : "(none)");
  if (c.actors?.length) row("actors", c.actors.join(", "));
  if (c.tags.length) row("tags", c.tags.join(", "));
  const m = c.metrics;
  row("metrics", `loc ${m.loc} · pagerank ${m.pagerank} · tests ${m.tests} · churn ${m.churn}`);
  if (c.fields?.length) row("fields", c.fields.map((f) => `${f.name}: ${f.type}${f.relation ? ` -> ${f.relation}` : ""}`).join(", "));
  if (c.children.total) {
    row("children", fmtList(c.children));
    for (const id of c.children.first) lines.push(`  ${id}`);
    if (c.children.total > c.children.first.length) lines.push(`  … and ${c.children.total - c.children.first.length} more`);
  }
  if (c.members) {
    row("members", fmtList(c.members));
    for (const id of c.members.first) lines.push(`  ${id}`);
  }
  if (c.unassignedFiles) {
    row("unmatched", `${c.unassignedFiles.length} code file(s) no system's paths match`);
    for (const rel of c.unassignedFiles.slice(0, CARD_LIST)) lines.push(`  ${rel}`);
    if (c.unassignedFiles.length > CARD_LIST) lines.push(`  … and ${c.unassignedFiles.length - CARD_LIST} more`);
  }
  row("out", `${c.edges.out} edge(s)${c.edges.out > c.out.length ? `, top ${c.out.length} by weight` : ""}`);
  for (const e of c.out) lines.push(fmtEdge(e, e.to, "->"));
  row("in", `${c.edges.in} edge(s)${c.edges.in > c.in.length ? `, top ${c.in.length} by weight` : ""}`);
  for (const e of c.in) lines.push(fmtEdge(e, e.from, "<-"));
  return `${lines.join("\n")}\n`;
}
