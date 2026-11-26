// `ultraview explain <node-id>` and `POST /api/explain`, as library calls
// (docs/design.md §7, §8.1): an instant, deterministic answer about one node,
// assembled only from proven material. No agent, no model, no file read
// beyond what `build` already wrote.
//
//   - prose already written and checked: the node's summary (model.json for a
//     system or a capability, the ultraindex encyclopedia for a module), its
//     tour stop and the flow steps on it — kept sentence by sentence, and only
//     the sentences whose every citation resolves;
//   - extractor facts: what the node is (a route's method, path and handler, an
//     entity's fields and relations, a job's schedule, …), cited where the fact
//     was found;
//   - the neighbourhood: callers and callees (codeindex call sites, resolved
//     through the import graph), data read and written, routes served,
//     externals reached, each cited at the line its evidence sits on.
//
// Every other sentence is a template (src/explain-strings.ts) filled with
// facts, one per line, so the answer passes the lens rules: every sentence
// cites, every citation resolves. `business` never names a symbol or a file
// (labels, capabilities, data names); `dev` does. `escalate` says the facts
// are thin, so the viewer can offer the agent instead.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkCitations, fileLineTable, loadCache } from "./engine.js";
import { type ExplainKey, type ExplainLang, EXPLAIN_LANGS, explainText } from "./explain-strings.js";
import { type CallFact, type EntityFact, type EntityUseFact, type Facts, type JobFact, RPC_METHODS, type RouteFact, type ScreenFact } from "./extract/types.js";
import { entityId, FOUNDATIONS_CAP, fileOfId, jobId, routeId, screenId, UNASSIGNED_SYS } from "./model/ids.js";
import type { LoadedInputs } from "./model/load.js";
import { splitSentences, uncitedSentences } from "./model/prose.js";
import type { LensEdge, ViewEdge, ViewEdgeKind, ViewModel, ViewNode } from "./model/types.js";
import { viewPaths } from "./paths.js";

export { EXPLAIN_LANGS, type ExplainLang } from "./explain-strings.js";

export const EXPLAIN_MODES = ["business", "dev"] as const;
export type ExplainMode = (typeof EXPLAIN_MODES)[number];

/** Items named per list sentence; the rest is counted ("and 3 more"). */
export const EXPLAIN_LIST = 6;
/**
 * Escalate when the node has no prose and fewer than this many facts beyond
 * what it is: the answer would only restate its kind and place.
 */
export const ESCALATE_FACTS = 2;
/** A language tag `--lang` / `lang` accepts (BCP-47-ish: `fr`, `pt-BR`, `zh-Hant`). */
export const LANG_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/;

export interface Explanation {
  node: string;
  kind: ViewNode["kind"];
  mode: ExplainMode;
  /** The language the templates are in. */
  lang: ExplainLang;
  /** The language asked for, when it has no templates and English was used instead. */
  langFallback?: string;
  /** Markdown, the shape of a lens answer: every sentence cites `[path:line]`. */
  answer: string;
  /** The node first, then every node the answer names, sorted. */
  nodes: string[];
  edges: LensEdge[];
  /** Every citation in `answer`, in order of first appearance. */
  citations: string[];
  /** Prose sentences kept and fact sentences written (beyond what the node is). */
  counts: { prose: number; facts: number };
  /** The facts are thin (no prose, fewer than ESCALATE_FACTS facts): offer the agent. */
  escalate: boolean;
  source: "facts";
}

/** One call the engine extracted in a file (codeindex `FileRecord.calls`); the engine's `CallSite` is a site of a callee, by name. */
interface FileCall {
  name: string;
  line: number;
}

/** A node defined in a file, with the lines it spans. */
interface Holder {
  node: ViewNode;
  start: number;
  end: number;
}

/** Everything explain reads, indexed once per view (cheap lookups per node afterwards). */
export interface ExplainContext {
  view: ViewModel;
  byId: Map<string, ViewNode>;
  facts: Facts;
  inputs: LoadedInputs["inputs"];
  lines: Map<string, number>;
  out: Map<string, ViewEdge[]>;
  children: Map<string, ViewNode[]>;
  holders: Map<string, Holder[]>;
  symsByName: Map<string, ViewNode[]>;
  imports: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  routeFacts: Map<string, RouteFact>;
  screenFacts: Map<string, ScreenFact>;
  jobFacts: Map<string, JobFact>;
  entityFacts: Map<string, EntityFact>;
  callsByRoute: Map<string, CallFact[]>;
  callsByFile: Map<string, CallFact[]>;
  usesByEntity: Map<string, EntityUseFact[]>;
  usesByFile: Map<string, EntityUseFact[]>;
  extsById: Map<string, Facts["externals"]>;
  extsByFile: Map<string, Facts["externals"]>;
  /** File → its call sites, from the codeindex extraction cache (loaded on first use). */
  callSites: () => Map<string, FileCall[]>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

let siteCache: { key: string; sites: Map<string, FileCall[]> } | undefined;

/** Call sites per file from `<repo>/.ultraindex/cache.json`, re-read only when that file changes. */
function loadFileCalls(root: string | undefined): Map<string, FileCall[]> {
  if (!root) return new Map();
  const index = viewPaths(root).index;
  const file = join(index, "cache.json");
  const key = existsSync(file) ? `${file}:${statSync(file).mtimeMs}` : "none";
  if (siteCache?.key === key) return siteCache.sites;
  const sites = new Map<string, FileCall[]>();
  for (const [rel, entry] of loadCache(index) ?? []) {
    const calls = entry.record.calls;
    if (calls?.length)
      sites.set(
        rel,
        calls.map((c) => ({ name: c.name, line: c.line })),
      );
  }
  siteCache = { key, sites };
  return sites;
}

const contexts = new WeakMap<ViewModel, ExplainContext>();

/** The explain index of a live view (`liveView`, or serve's state), built once per view object. */
export function explainContext(live: { view: ViewModel; byId: Map<string, ViewNode>; loaded: LoadedInputs }): ExplainContext {
  const cached = contexts.get(live.view);
  if (cached) return cached;
  const { view, byId } = live;
  const inputs = live.loaded.inputs;
  const facts = inputs.facts;
  const out = new Map<string, ViewEdge[]>();
  const imports = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  for (const e of view.edges) {
    push(out, e.from, e);
    if (e.kind === "import" && e.from.startsWith("file:") && e.to.startsWith("file:")) {
      const a = e.from.slice(5);
      const b = e.to.slice(5);
      if (!imports.has(a)) imports.set(a, new Set());
      imports.get(a)!.add(b);
      if (!importers.has(b)) importers.set(b, new Set());
      importers.get(b)!.add(a);
    }
  }
  const routeFacts = new Map(facts.routes.map((r) => [routeId(r.method, r.path), r]));
  const screenFacts = new Map(facts.screens.map((s) => [screenId(s.path), s]));
  const jobFacts = new Map(facts.jobs.map((j) => [jobId(j.id), j]));
  const entityFacts = new Map(facts.entities.map((e) => [entityId(e.name), e]));
  const children = new Map<string, ViewNode[]>();
  const holders = new Map<string, Holder[]>();
  const symsByName = new Map<string, ViewNode[]>();
  for (const n of view.nodes) {
    if (n.parent) push(children, n.parent, n);
    if (n.kind === "sym") push(symsByName, n.label, n);
    const at = atOf(n.at);
    if (!at) continue;
    const fact = routeFacts.get(n.id) ?? screenFacts.get(n.id) ?? jobFacts.get(n.id);
    const end = n.kind === "sym" ? at.line + Math.max(0, n.metrics.loc - 1) : (fact?.end ?? at.line);
    if (n.kind === "sym" || n.kind === "route" || n.kind === "screen" || n.kind === "job") push(holders, at.file, { node: n, start: at.line, end });
  }
  const ctx: ExplainContext = {
    view,
    byId,
    facts,
    inputs,
    lines: fileLineTable(inputs.graph),
    out,
    children,
    holders,
    symsByName,
    imports,
    importers,
    routeFacts,
    screenFacts,
    jobFacts,
    entityFacts,
    callsByRoute: new Map(),
    callsByFile: new Map(),
    usesByEntity: new Map(),
    usesByFile: new Map(),
    extsById: new Map(),
    extsByFile: new Map(),
    callSites: () => loadFileCalls(inputs.root),
  };
  for (const c of facts.calls) {
    push(ctx.callsByFile, c.file, c);
    if (c.route) push(ctx.callsByRoute, c.route, c);
  }
  for (const u of facts.entityUses) {
    push(ctx.usesByEntity, entityId(u.entity), u);
    push(ctx.usesByFile, u.file, u);
  }
  for (const x of facts.externals) {
    push(ctx.extsById, `ext:${x.id}`, x);
    push(ctx.extsByFile, x.file, x);
  }
  contexts.set(view, ctx);
  return ctx;
}

function atOf(at: string | undefined): { file: string; line: number } | undefined {
  if (!at) return undefined;
  const i = at.lastIndexOf(":");
  const line = Number(at.slice(i + 1));
  return i > 0 && Number.isInteger(line) && line > 0 ? { file: at.slice(0, i), line } : undefined;
}

/** The language the templates use for `lang`, and whether it fell back to English. */
export function resolveExplainLang(lang: string | undefined): { lang: ExplainLang; fallback?: string } {
  if (!lang) return { lang: "en" };
  const base = lang.toLowerCase().split(/[-_]/)[0]!;
  return (EXPLAIN_LANGS as readonly string[]).includes(base) ? { lang: base as ExplainLang } : { lang: "en", fallback: lang };
}

/** One named, cited item of a list sentence. */
interface Item {
  name: string;
  cite: string;
  node?: string;
  edge?: LensEdge;
}

class Writer {
  readonly prose: string[] = [];
  readonly bullets: string[] = [];
  facts = 0;
  readonly nodes = new Set<string>();
  readonly edges = new Map<string, LensEdge>();

  constructor(
    readonly ctx: ExplainContext,
    readonly node: ViewNode,
    readonly mode: ExplainMode,
    readonly lang: ExplainLang,
  ) {}

  t(key: ExplainKey, params: Record<string, string | number> = {}): string {
    return explainText(this.lang, key, params);
  }

  /** `[path:line]` / `[path:start-end]`, or undefined when the index does not hold those lines. */
  cite(file: string, line: number, end?: number): string | undefined {
    const n = this.ctx.lines.get(file);
    if (!n || line < 1 || line > n) return undefined;
    const last = end !== undefined ? Math.min(end, n) : line;
    return last > line ? `[${file}:${line}-${last}]` : `[${file}:${line}]`;
  }

  /** Cited sentences of agent-written prose (every citation resolving), in order; uncited ones are dropped. */
  keptSentences(text: string | undefined): string[] {
    if (!text) return [];
    return splitSentences(text).filter((s) => {
      const check = checkCitations(s, this.ctx.lines);
      return check.resolved.length > 0 && check.unresolved.length === 0 && uncitedSentences(s).length === 0;
    });
  }

  addProse(text: string | undefined): void {
    const kept = this.keptSentences(text);
    if (kept.length) this.prose.push(kept.join(" "));
  }

  /** One fact sentence; dropped when it would not pass the citation rules. `identity` sentences do not count as facts. */
  line(sentence: string, identity = false): void {
    if (uncitedSentences(sentence).length) return;
    this.bullets.push(`- ${sentence}`);
    if (!identity) this.facts++;
  }

  is(key: ExplainKey, params: Record<string, string | number>, cite: string | undefined): void {
    if (cite) this.line(`${this.t(key, params)} ${cite}`, true);
  }

  /** A list sentence: `key` with `{list}` = the items, each followed by its citation; merged by name, first cite kept. */
  list(key: ExplainKey, items: Item[], params: Record<string, string | number> = {}): void {
    const seen = new Map<string, Item>();
    for (const i of items) if (!seen.has(i.name)) seen.set(i.name, i);
    const uniq = [...seen.values()];
    if (!uniq.length) return;
    for (const i of items) {
      if (i.node) this.nodes.add(i.node);
      if (i.edge) this.edges.set(`${i.edge.from}\n${i.edge.to}\n${i.edge.kind ?? ""}`, i.edge);
    }
    const shown = uniq.slice(0, EXPLAIN_LIST).map((i) => `${i.name} ${i.cite}`);
    const more = uniq.length > EXPLAIN_LIST ? `, ${this.t("more", { n: uniq.length - EXPLAIN_LIST })}` : "";
    this.line(this.t(key, { ...params, list: `${shown.join(", ")}${more}` }));
  }

  /** A list sentence over names that all rest on the same citation: `key` with `{list}`, then the one citation. */
  listAt(
    key: ExplainKey,
    names: { name: string; node?: string; edge?: LensEdge }[],
    cite: string | undefined,
    params: Record<string, string | number> = {},
  ): void {
    const uniq = [...new Set(names.map((x) => x.name))];
    if (!cite || !uniq.length) return;
    for (const x of names) {
      if (x.node) this.nodes.add(x.node);
      if (x.edge) this.edges.set(`${x.edge.from}\n${x.edge.to}\n${x.edge.kind ?? ""}`, x.edge);
    }
    const more = uniq.length > EXPLAIN_LIST ? `, ${this.t("more", { n: uniq.length - EXPLAIN_LIST })}` : "";
    this.line(`${this.t(key, { ...params, list: `${uniq.slice(0, EXPLAIN_LIST).join(", ")}${more}` })} ${cite}`);
  }

  get dev(): boolean {
    return this.mode === "dev";
  }

  /** How the answer names a node: code names in dev, plain words in business (never a symbol or a file). */
  name(n: ViewNode): string {
    if (this.dev) {
      if (n.kind === "file") return `\`${fileOfId(n.id)}\``;
      if (n.kind === "cap" || n.kind === "sys") return n.label;
      return `\`${n.label}\``;
    }
    return n.kind === "sym" || n.kind === "file" ? this.place(n) : n.label;
  }

  /** Where a node sits, in plain words: its capabilities, else its system, else its module. */
  place(n: ViewNode): string {
    const caps = n.caps.filter((c) => c !== FOUNDATIONS_CAP).map((c) => this.ctx.byId.get(c)?.label ?? c);
    return caps.length ? caps.join(", ") : this.system(n);
  }

  /** The system a node sits in (its label), else its module, else the app. */
  system(n: ViewNode): string {
    let cur: ViewNode | undefined = n;
    let mod: ViewNode | undefined;
    while (cur) {
      if (cur.kind === "mod") mod ??= cur;
      if (cur.kind === "sys" && cur.id !== UNASSIGNED_SYS) return cur.label;
      cur = cur.parent ? this.ctx.byId.get(cur.parent) : undefined;
    }
    return mod?.label ?? this.ctx.view.app.name;
  }

  /** The innermost route / screen / job / symbol spanning `line` of `file`, else the file. */
  holderAt(file: string, line: number): ViewNode | undefined {
    let best: Holder | undefined;
    for (const h of this.ctx.holders.get(file) ?? []) {
      if (line < h.start || line > h.end) continue;
      if (!best || h.end - h.start < best.end - best.start) best = h;
    }
    return best?.node ?? this.ctx.byId.get(`file:${file}`);
  }

  /** The exported symbols a call site in `file` reaches: same file or a file it imports. */
  callees(file: string, name: string, self: string): ViewNode[] {
    const imported = this.ctx.imports.get(file);
    return (this.ctx.symsByName.get(name) ?? []).filter((s) => {
      if (s.id === self) return false;
      const f = s.parent ? fileOfId(s.parent) : undefined;
      return f === file || (f !== undefined && !!imported?.has(f));
    });
  }

  edge(from: string, to: string, kind: ViewEdgeKind): LensEdge {
    return { from, to, kind };
  }
}

/** A call to a tRPC procedure or a server action is rpc; any other route, http (as the assembler draws it). */
function routeEdge(route: string): ViewEdgeKind {
  return RPC_METHODS.has(route.slice("route:".length).split(" ")[0] ?? "") ? "rpc" : "http";
}

/** The lines `node` spans in its file (a route, screen, job or symbol). */
function spanOf(w: Writer, n: ViewNode): { file: string; start: number; end: number } | undefined {
  const at = atOf(n.at);
  if (!at) return undefined;
  const h = (w.ctx.holders.get(at.file) ?? []).find((x) => x.node.id === n.id);
  return { file: at.file, start: at.line, end: h?.end ?? at.line };
}

/** Calls, data and routes reached from the lines `[start, end]` of `file`, on behalf of `self`. */
function reach(w: Writer, self: ViewNode, file: string, start: number, end: number): void {
  const calls: Item[] = [];
  const reads: Item[] = [];
  const writes: Item[] = [];
  const exts: Item[] = [];
  const data = (uses: EntityUseFact[] | undefined, from: number, to: number) => {
    for (const u of uses ?? []) {
      if (u.line < from || u.line > to) continue;
      const ent = w.ctx.byId.get(entityId(u.entity));
      const cite = w.cite(u.file, u.line);
      if (!ent || !cite) continue;
      (u.op === "read" ? reads : writes).push({ name: w.name(ent), cite, node: ent.id, edge: w.edge(self.id, ent.id, "data") });
    }
  };
  const outside = (inFile: string, from: number, to: number) => {
    data(w.ctx.usesByFile.get(inFile), from, to);
    for (const x of w.ctx.extsByFile.get(inFile) ?? []) {
      const ext = w.ctx.byId.get(`ext:${x.id}`);
      const cite = w.cite(x.file, x.line);
      if (ext && cite && x.line >= from && x.line <= to) exts.push({ name: w.name(ext), cite, node: ext.id, edge: w.edge(self.id, ext.id, "call") });
    }
  };
  outside(file, start, end);
  for (const site of w.ctx.callSites().get(file) ?? []) {
    if (site.line < start || site.line > end) continue;
    for (const callee of w.callees(file, site.name, self.id)) {
      const cite = w.cite(file, site.line);
      if (!cite) continue;
      calls.push({ name: w.name(callee), cite, node: callee.id, edge: w.edge(self.id, callee.id, "call") });
      // One hop further: the data and the externals the callee reaches.
      const span = spanOf(w, callee);
      if (span) outside(span.file, span.start, span.end);
    }
  }
  for (const c of w.ctx.callsByFile.get(file) ?? []) {
    if (c.line < start || c.line > end || !c.route) continue;
    const route = w.ctx.byId.get(c.route);
    const cite = w.cite(c.file, c.line);
    if (route && cite) calls.push({ name: w.name(route), cite, node: route.id, edge: w.edge(self.id, route.id, routeEdge(route.id)) });
  }
  // Business words never name a function: the calls show through the data they reach.
  if (w.dev) w.list("rel.calls", calls);
  else
    w.list(
      "rel.calls",
      calls.filter((i) => i.node && !i.node.startsWith("sym:")),
    );
  w.list("rel.reads", reads);
  w.list("rel.writes", writes);
  w.list("rel.externals", exts);
}

/** Who calls the symbol `sym`: call sites by its name in its own file and in the files importing it. */
function callersOf(w: Writer, sym: ViewNode): void {
  const span = spanOf(w, sym);
  if (!span) return;
  const items: Item[] = [];
  const files = [span.file, ...[...(w.ctx.importers.get(span.file) ?? [])].sort(cmp)];
  for (const f of files) {
    for (const site of w.ctx.callSites().get(f) ?? []) {
      if (site.name !== sym.label) continue;
      if (f === span.file && site.line >= span.start && site.line <= span.end) continue;
      const holder = w.holderAt(f, site.line);
      const cite = w.cite(f, site.line);
      if (!holder || !cite || holder.id === sym.id) continue;
      items.push({ name: w.name(holder), cite, node: holder.id, edge: w.edge(holder.id, sym.id, "call") });
    }
  }
  w.list("rel.calledBy", items);
}

function capsLine(w: Writer, n: ViewNode, cite: string | undefined): void {
  if (!cite) return;
  const caps = n.caps.filter((c) => c !== FOUNDATIONS_CAP && w.ctx.byId.has(c));
  w.listAt(
    "rel.caps",
    caps.map((c) => ({ name: w.ctx.byId.get(c)!.label, node: c })),
    cite,
  );
}

/** Hand-written model.json edges touching the node, cited where the model says they rest. */
function modelEdges(w: Writer, n: ViewNode): void {
  for (const e of w.ctx.view.edges) {
    if (e.derived || !e.cite || (e.from !== n.id && e.to !== n.id)) continue;
    const other = w.ctx.byId.get(e.from === n.id ? e.to : e.from);
    const cite = `[${e.cite}]`;
    const check = checkCitations(cite, w.ctx.lines);
    if (!other || !check.resolved.length || check.unresolved.length) continue;
    w.nodes.add(other.id);
    w.edges.set(`${e.from}\n${e.to}\n${e.kind}`, { from: e.from, to: e.to, kind: e.kind });
    w.line(`${e.label ? w.t("rel.model", { name: w.name(other), label: e.label }) : w.t("rel.modelNoLabel", { name: w.name(other) })} ${cite}`);
  }
}

/** Prose on the node itself: its summary, its tour stop, the flow steps that name it. */
function proseOf(w: Writer, n: ViewNode): void {
  w.addProse(n.summary);
  for (const stop of w.ctx.inputs.model?.tour ?? []) if (stop.node === n.id) w.addProse(stop.note);
  for (const flow of w.ctx.inputs.flows) {
    flow.steps.forEach((s, i) => {
      if (s.node !== n.id) return;
      const kept = w.keptSentences(s.note);
      if (kept.length) w.prose.push(w.t("flow.step", { title: flow.title, n: i + 1, note: kept.join(" ") }));
    });
  }
}

const METHOD_VERB: Record<string, ExplainKey> = {
  GET: "verb.read",
  HEAD: "verb.read",
  QUERY: "verb.read",
  SUBSCRIPTION: "verb.read",
  POST: "verb.create",
  PUT: "verb.update",
  PATCH: "verb.update",
  MUTATION: "verb.update",
  DELETE: "verb.delete",
  ACTION: "verb.action",
};

function explainRoute(w: Writer, n: ViewNode): void {
  const r = w.ctx.routeFacts.get(n.id);
  if (!r) return;
  const cite = w.cite(r.file, r.line, r.end);
  if (w.dev) w.is(r.handler ? "is.route.dev.handler" : "is.route.dev", { name: n.label, framework: r.framework, file: r.file, handler: r.handler ?? "" }, cite);
  else w.is("is.route.business", { name: n.label, verb: w.t(METHOD_VERB[r.method.toUpperCase()] ?? "verb.any") }, cite);
  capsLine(w, n, cite);
  const callers: Item[] = [];
  for (const c of w.ctx.callsByRoute.get(n.id) ?? []) {
    const holder = w.holderAt(c.file, c.line);
    const at = w.cite(c.file, c.line);
    if (holder && at) callers.push({ name: w.name(holder), cite: at, node: holder.id, edge: w.edge(holder.id, n.id, routeEdge(n.id)) });
  }
  w.list("rel.calledBy", callers);
  reach(w, n, r.file, r.line, r.end ?? r.line);
}

function explainScreen(w: Writer, n: ViewNode): void {
  const s = w.ctx.screenFacts.get(n.id);
  if (!s) return;
  const cite = w.cite(s.file, s.line, s.end);
  w.is(w.dev ? "is.screen.dev" : "is.screen.business", { name: n.label, framework: s.framework, file: s.file }, cite);
  capsLine(w, n, cite);
  reach(w, n, s.file, s.line, s.end ?? w.ctx.lines.get(s.file) ?? s.line);
}

function explainJob(w: Writer, n: ViewNode): void {
  const j = w.ctx.jobFacts.get(n.id);
  if (!j) return;
  const cite = w.cite(j.file, j.line, j.end);
  if (w.dev) w.is(j.schedule ? "is.job.dev.schedule" : "is.job.dev", { name: n.label, kind: j.kind, file: j.file, schedule: j.schedule ?? "" }, cite);
  else w.is(`is.job.business.${j.kind}` as ExplainKey, { name: n.label }, cite);
  capsLine(w, n, cite);
  reach(w, n, j.file, j.line, j.end ?? j.line);
}

/** Who reaches a holder in business words: the routes, screens or jobs that call it, else its place. */
function businessReach(w: Writer, holder: ViewNode): string[] {
  if (holder.kind !== "sym") return [w.name(holder)];
  const span = spanOf(w, holder);
  const names = new Set<string>();
  if (span) {
    for (const f of [span.file, ...(w.ctx.importers.get(span.file) ?? [])]) {
      for (const site of w.ctx.callSites().get(f) ?? []) {
        if (site.name !== holder.label) continue;
        const h = w.holderAt(f, site.line);
        if (h && h.kind !== "sym" && h.kind !== "file") names.add(h.label);
      }
    }
  }
  return names.size ? [...names].sort(cmp) : [w.place(holder)];
}

function explainEntity(w: Writer, n: ViewNode): void {
  const e = w.ctx.entityFacts.get(n.id);
  if (!e) return;
  const cite = w.cite(e.file, e.line, e.end);
  const fields = w.dev ? e.fields.map((f) => `${f.name}: ${f.type}`).join(", ") : e.fields.map((f) => f.name).join(", ");
  w.is(w.dev ? "is.entity.dev" : "is.entity.business", { name: n.label, orm: e.orm, file: e.file, fields: fields || "-" }, cite);
  capsLine(w, n, cite);
  if (cite) {
    const rel = e.fields.filter((f) => f.relation && w.ctx.byId.has(entityId(f.relation)));
    const items = rel.map((f) => {
      const other = entityId(f.relation!);
      return { name: w.dev ? `${f.name} → \`${f.relation}\`` : f.relation!, node: other, edge: w.edge(n.id, other, "data" as const) };
    });
    w.listAt(w.dev ? "rel.fields.dev" : "rel.fields.business", items, cite, { name: n.label });
    const refs: Item[] = [];
    for (const other of w.ctx.facts.entities) {
      if (other.name === e.name || !other.fields.some((f) => f.relation === e.name)) continue;
      const at = w.cite(other.file, other.line, other.end);
      if (at) refs.push({ name: w.name(w.ctx.byId.get(entityId(other.name)) ?? n), cite: at, node: entityId(other.name) });
    }
    w.list("rel.referencedBy", refs);
  }
  const readBy: Item[] = [];
  const writtenBy: Item[] = [];
  for (const u of w.ctx.usesByEntity.get(n.id) ?? []) {
    const holder = w.holderAt(u.file, u.line);
    const at = w.cite(u.file, u.line);
    if (!holder || !at) continue;
    const names = w.dev ? [w.name(holder)] : businessReach(w, holder);
    for (const name of names) (u.op === "read" ? readBy : writtenBy).push({ name, cite: at, node: holder.id, edge: w.edge(holder.id, n.id, "data") });
  }
  w.list("rel.readBy", readBy);
  w.list("rel.writtenBy", writtenBy);
}

function explainExternal(w: Writer, n: ViewNode): void {
  const sites = [...(w.ctx.extsById.get(n.id) ?? [])].sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
  const first = sites[0];
  if (!first) return;
  const vias = [...new Set(sites.map((s) => s.via))].sort(cmp).join(", ");
  w.is(w.dev ? "is.ext.dev" : "is.ext.business", { name: n.label, via: vias }, w.cite(first.file, first.line));
  const items: Item[] = [];
  for (const s of sites) {
    const holder = w.holderAt(s.file, s.line);
    const at = w.cite(s.file, s.line);
    if (holder && at) items.push({ name: w.name(holder), cite: at, node: holder.id, edge: w.edge(holder.id, n.id, "call") });
  }
  w.list("rel.usedBy", items);
}

function explainInfra(w: Writer, n: ViewNode): void {
  const i = w.ctx.facts.infra.find((x) => `infra:${x.id}` === n.id);
  if (!i) return;
  w.is(w.dev ? "is.infra.dev" : "is.infra.business", { name: n.label, kind: i.kind, file: i.file }, w.cite(i.file, i.line));
}

function explainSym(w: Writer, n: ViewNode): void {
  const span = spanOf(w, n);
  if (!span) return;
  const cite = w.cite(span.file, span.start, span.end);
  if (w.dev) w.is("is.sym.dev", { name: n.label, kind: n.tags[0] ?? "symbol", file: span.file }, cite);
  else w.is("is.sym.business", { place: w.system(n) }, cite);
  capsLine(w, n, cite);
  callersOf(w, n);
  reach(w, n, span.file, span.start, span.end);
}

/** Definition order: by file, then line. */
function byPlace(a: ViewNode, b: ViewNode): number {
  const x = atOf(a.at);
  const y = atOf(b.at);
  return cmp(x?.file ?? "", y?.file ?? "") || (x?.line ?? 0) - (y?.line ?? 0) || cmp(a.id, b.id);
}

/**
 * What a set of files declares (routes, screens, entities, jobs, symbols in
 * dev) and uses (data read and written, externals), for a file, module,
 * system or capability. `keep` narrows the uses to the lines whose holder
 * belongs (a capability's own symbols in a shared file).
 */
function explainFiles(w: Writer, self: ViewNode, files: ViewNode[], declared: ViewNode[], keep: (holder: ViewNode | undefined) => boolean = () => true): void {
  const byKind = (kind: ViewNode["kind"]) =>
    declared
      .filter((x) => x.kind === kind)
      .sort(byPlace)
      .flatMap((x): Item[] => {
        const at = atOf(x.at);
        const cite = at && w.cite(at.file, at.line);
        return cite ? [{ name: w.name(x), cite, node: x.id }] : [];
      });
  w.list("rel.routes", byKind("route"));
  w.list("rel.screens", byKind("screen"));
  w.list("rel.entities", byKind("entity"));
  w.list("rel.jobs", byKind("job"));
  const reads: Item[] = [];
  const writes: Item[] = [];
  const exts: Item[] = [];
  for (const rel of files.map((f) => fileOfId(f.id)!).sort(cmp)) {
    for (const u of w.ctx.usesByFile.get(rel) ?? []) {
      const ent = w.ctx.byId.get(entityId(u.entity));
      const cite = w.cite(u.file, u.line);
      if (ent && cite && keep(w.holderAt(u.file, u.line)))
        (u.op === "read" ? reads : writes).push({ name: w.name(ent), cite, node: ent.id, edge: w.edge(self.id, ent.id, "data") });
    }
    for (const x of w.ctx.extsByFile.get(rel) ?? []) {
      const ext = w.ctx.byId.get(`ext:${x.id}`);
      const cite = w.cite(x.file, x.line);
      if (ext && cite && keep(w.holderAt(x.file, x.line))) exts.push({ name: w.name(ext), cite, node: ext.id, edge: w.edge(self.id, ext.id, "call") });
    }
  }
  w.list("rel.reads", reads);
  w.list("rel.writes", writes);
  w.list("rel.externals", exts);
  if (w.dev) w.list("rel.defines", byKind("sym"));
}

function explainFile(w: Writer, n: ViewNode): void {
  const rel = fileOfId(n.id)!;
  const cite = w.cite(rel, 1);
  const mod = n.parent ? w.ctx.byId.get(n.parent) : undefined;
  if (w.dev) w.is("is.file.dev", { name: rel, kind: n.tags.find((t) => t !== "test") ?? "source", module: mod?.label ?? "-" }, cite);
  else w.is("is.file.business", { place: w.system(n) }, cite);
  capsLine(w, n, cite);
  explainFiles(w, n, [n], w.ctx.children.get(n.id) ?? []);
}

/** Module, system or capability: what its files declare and use. */
function explainGroup(w: Writer, n: ViewNode): void {
  const nodes = w.ctx.view.nodes;
  if (n.kind === "cap") {
    // A capability's own members (claimed, or inherited from a claimed file), and the uses inside them.
    const files = nodes.filter((x) => x.kind === "file" && x.caps.includes(n.id) && !x.tags.includes("test"));
    const declared = nodes.filter((x) => x.caps.includes(n.id) && x.kind !== "file" && x.kind !== "mod" && x.kind !== "sys");
    explainFiles(w, n, files, declared, (h) => !!h && h.caps.includes(n.id));
    return;
  }
  let files: ViewNode[];
  if (n.kind === "sys") {
    const mods = new Set((w.ctx.children.get(n.id) ?? []).map((m) => m.id));
    files = nodes.filter((x) => x.kind === "file" && x.parent !== undefined && mods.has(x.parent));
  } else files = (w.ctx.children.get(n.id) ?? []).filter((x) => x.kind === "file");
  files = files.filter((f) => !f.tags.includes("test"));
  explainFiles(
    w,
    n,
    files,
    files.flatMap((f) => w.ctx.children.get(f.id) ?? []),
  );
  if (w.dev && n.kind === "mod") {
    const items = [...files]
      .sort((a, b) => b.metrics.pagerank - a.metrics.pagerank || cmp(a.id, b.id))
      .flatMap((f): Item[] => {
        const cite = w.cite(fileOfId(f.id)!, 1);
        return cite ? [{ name: w.name(f), cite, node: f.id }] : [];
      });
    w.list("rel.files", items);
  }
}

/** Explain one node from proven material; undefined when the id is unknown. */
export function explainNode(ctx: ExplainContext, id: string, opts: { mode?: ExplainMode; lang?: string } = {}): Explanation | undefined {
  const n = ctx.byId.get(id);
  if (!n) return undefined;
  const mode = opts.mode ?? "business";
  const { lang, fallback } = resolveExplainLang(opts.lang);
  const w = new Writer(ctx, n, mode, lang);
  proseOf(w, n);
  switch (n.kind) {
    case "route":
      explainRoute(w, n);
      break;
    case "screen":
      explainScreen(w, n);
      break;
    case "job":
      explainJob(w, n);
      break;
    case "entity":
      explainEntity(w, n);
      break;
    case "ext":
      explainExternal(w, n);
      break;
    case "infra":
      explainInfra(w, n);
      break;
    case "sym":
      explainSym(w, n);
      break;
    case "file":
      explainFile(w, n);
      break;
    default:
      explainGroup(w, n);
  }
  modelEdges(w, n);
  const answer = [...w.prose, ...(w.bullets.length ? [w.bullets.join("\n")] : [])].join("\n\n");
  const citations: string[] = [];
  for (const m of answer.matchAll(/\[([^\s[\]]+:\d+(?:-\d+)?)\]/g)) if (!citations.includes(m[1]!)) citations.push(m[1]!);
  w.nodes.delete(n.id);
  const proseCount = w.prose.reduce((k, p) => k + splitSentences(p).length, 0);
  return {
    node: n.id,
    kind: n.kind,
    mode,
    lang,
    ...(fallback ? { langFallback: fallback } : {}),
    answer,
    nodes: [n.id, ...[...w.nodes].sort(cmp)],
    edges: [...w.edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind ?? "", b.kind ?? "")),
    citations,
    counts: { prose: proseCount, facts: w.facts },
    escalate: proseCount === 0 && w.facts < ESCALATE_FACTS,
    source: "facts",
  };
}

/** A `{node, mode, lang?}` request (the body of `POST /api/explain`), checked; the HTTP status and JSON to send. */
export function explainRequest(ctx: ExplainContext, body: string, suggest: (id: string) => string[] = () => []): { status: number; value: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, value: { error: "body is not JSON" } };
  }
  const req = (parsed ?? {}) as { node?: unknown; mode?: unknown; lang?: unknown };
  if (typeof req.node !== "string" || !req.node) return { status: 400, value: { error: "`node` must be a node id" } };
  const mode = req.mode ?? "business";
  if (typeof mode !== "string" || !(EXPLAIN_MODES as readonly string[]).includes(mode))
    return { status: 400, value: { error: `\`mode\` must be one of ${EXPLAIN_MODES.join(", ")}` } };
  if (req.lang !== undefined && (typeof req.lang !== "string" || !LANG_RE.test(req.lang)))
    return { status: 400, value: { error: "`lang` must be a language tag (en, fr, pt-BR…)" } };
  const x = explainNode(ctx, req.node, { mode: mode as ExplainMode, lang: req.lang as string | undefined });
  if (!x) return { status: 404, value: { error: `unknown node id: ${req.node}`, suggestions: suggest(req.node) } };
  return { status: 200, value: x };
}

/** The plain-text rendering for the terminal: the answer, then what the UI would show next to it. */
export function formatExplanation(x: Explanation): string {
  const lines = [x.answer || "(no proven material on this node)", ""];
  lines.push(`nodes     ${x.nodes.join(", ")}`);
  if (x.langFallback) lines.push(`lang      no templates for "${x.langFallback}": English used`);
  lines.push(
    `escalate  ${x.escalate ? `yes: ${x.counts.prose} prose sentence(s), ${x.counts.facts} fact(s); ask the agent for more` : `no (${x.counts.prose} prose sentence(s), ${x.counts.facts} fact(s))`}`,
  );
  return `${lines.join("\n")}\n`;
}
