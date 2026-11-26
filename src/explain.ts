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
//     externals reached, each cited at the line its evidence sits on;
//   - for a system, a module or a capability, what it is made of and what it
//     leans on: its main modules or files (by PageRank, cited at the file),
//     its entry points (the bin / main / scripts of the package.json or
//     pyproject.toml its files hold or point at, cited at the manifest's line;
//     the only files read here, once per view), the systems / modules /
//     capabilities it depends on and that depend on it (view edges, cited at a
//     call site of the file-level edge underneath, else at the importing file),
//     the tests covering its files and its most changed files (cited at the
//     file).
//
// Every other sentence is a template (src/explain-strings.ts) filled with
// facts, one per line, so the answer passes the lens rules: every sentence
// cites, every citation resolves. `business` never names a symbol or a file
// (labels, capabilities, data names); `dev` does. `escalate` says the facts
// are thin, so the viewer can offer the agent instead.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { checkCitations, codeindex, fileLineTable, loadCache } from "./engine.js";
import { type ExplainKey, type ExplainLang, EXPLAIN_LANGS, explainText } from "./explain-strings.js";
import { type CallFact, type EntityFact, type EntityUseFact, type Facts, type JobFact, RPC_METHODS, type RouteFact, type ScreenFact } from "./extract/types.js";
import { humanizeSegment } from "./model/assemble.js";
import { entityId, FOUNDATIONS_CAP, fileOfId, jobId, kindOf, routeId, screenId, UNASSIGNED_SYS } from "./model/ids.js";
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
/**
 * The same bar for a system, a module or a capability, higher: its parts, its
 * tests and its neighbours are there for almost any group, so two of them
 * still say little about what it does. Fewer than this many fact sentences and
 * no prose: escalate.
 */
export const ESCALATE_GROUP_FACTS = 3;
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
  /** The facts are thin (no prose, fewer than ESCALATE_FACTS facts, ESCALATE_GROUP_FACTS for a system / module / capability): offer the agent. */
  escalate: boolean;
  source: "facts";
}

/** One call the engine extracted in a file (codeindex `FileRecord.calls`); the engine's `CallSite` is a site of a callee, by name. */
interface FileCall {
  name: string;
  line: number;
  receiver?: string;
}

/** One entry point a manifest declares, at the line it sits on. */
interface ManifestEntry {
  kind: "bin" | "main" | "script";
  name: string;
  line: number;
  /** bin / main: the path (or `module:function`) it starts. */
  target?: string;
  /** script: its command line. */
  command?: string;
}

/** A package.json or pyproject.toml of the view, and the entry points it declares. */
interface ManifestInfo {
  rel: string;
  /** Its directory, repo-relative ("" at the root). */
  dir: string;
  entries: ManifestEntry[];
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
  inn: Map<string, ViewEdge[]>;
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
  /** File → the test files covering it (codeindex test map, computed on first use). */
  testsOf: () => Map<string, string[]>;
  /** The manifests of the view with their entry points (read on first use). */
  manifests: () => ManifestInfo[];
  /** The enclosing module (slice) or system of a node, memoized. */
  ancestor: (id: string, kind: "mod" | "sys") => string | undefined;
  /** The names a file exports (its symbols' labels), memoized. */
  exportsOf: (rel: string) => Set<string>;
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
        calls.map((c) => ({ name: c.name, line: c.line, ...(c.receiver ? { receiver: c.receiver } : {}) })),
      );
  }
  siteCache = { key, sites };
  return sites;
}

/** `make` run on the first call, its value kept. */
function once<T>(make: () => T): () => T {
  let value: { v: T } | undefined;
  return () => (value ??= { v: make() }).v;
}

/** The line of every key of a JSON object document, by its path (`bin`, `scripts\0dev`). */
export function jsonKeyLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const keys: string[] = [];
  const open: string[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    else if (c === "{" || c === "[") open.push(c);
    else if (c === "}" || c === "]") {
      open.pop();
      keys.length = Math.min(keys.length, open.length);
    } else if (c === '"') {
      let str = "";
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
        str += text[i];
      }
      if (open[open.length - 1] !== "{") continue;
      let k = i + 1;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (text[k] !== ":") continue;
      keys.length = open.length - 1;
      keys.push(str);
      out.set(keys.join("\0"), line);
    }
  }
  return out;
}

/** The entry points of a package.json: its bin commands, its main file, its scripts. */
function packageEntries(text: string): ManifestEntry[] {
  let pkg: { name?: unknown; bin?: unknown; main?: unknown; scripts?: unknown };
  try {
    pkg = JSON.parse(text) ?? {};
  } catch {
    return [];
  }
  if (typeof pkg !== "object") return [];
  const lines = jsonKeyLines(text);
  const entries: ManifestEntry[] = [];
  const add = (e: Omit<ManifestEntry, "line">, key: string) => {
    const line = lines.get(key);
    if (line) entries.push({ ...e, line });
  };
  if (typeof pkg.bin === "string" && typeof pkg.name === "string") add({ kind: "bin", name: pkg.name.split("/").pop()!, target: pkg.bin }, "bin");
  else if (pkg.bin && typeof pkg.bin === "object")
    for (const [name, target] of Object.entries(pkg.bin)) if (typeof target === "string") add({ kind: "bin", name, target }, `bin\0${name}`);
  if (typeof pkg.main === "string") add({ kind: "main", name: pkg.main, target: pkg.main }, "main");
  if (pkg.scripts && typeof pkg.scripts === "object")
    for (const [name, command] of Object.entries(pkg.scripts)) if (typeof command === "string") add({ kind: "script", name, command }, `scripts\0${name}`);
  return entries;
}

/** The console scripts of a pyproject.toml (`[project.scripts]`, `[tool.poetry.scripts]`). */
function pyprojectEntries(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  let section = "";
  text.split("\n").forEach((l, i) => {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(l);
    if (head) section = head[1]!.trim();
    else if (section === "project.scripts" || section === "tool.poetry.scripts") {
      const m = /^\s*"?([\w.-]+)"?\s*=\s*"([^"]+)"/.exec(l);
      if (m) entries.push({ kind: "bin", name: m[1]!, target: m[2]!, line: i + 1 });
    }
  });
  return entries;
}

/** Every package.json / pyproject.toml file node of the view, read and parsed. */
function loadManifests(root: string | undefined, nodes: readonly ViewNode[]): ManifestInfo[] {
  if (!root) return [];
  const out: ManifestInfo[] = [];
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const rel = n.id.slice("file:".length);
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (base !== "package.json" && base !== "pyproject.toml") continue;
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const entries = base === "package.json" ? packageEntries(text) : pyprojectEntries(text);
    if (entries.length) out.push({ rel, dir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "", entries });
  }
  return out;
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
  const inn = new Map<string, ViewEdge[]>();
  const imports = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  for (const e of view.edges) {
    push(out, e.from, e);
    push(inn, e.to, e);
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
  const modOf = new Map<string, string | undefined>();
  const sysOf = new Map<string, string | undefined>();
  const exportsByFile = new Map<string, Set<string>>();
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
    inn,
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
    testsOf: once(() => codeindex.computeTestMap(inputs.graph).testedByFile),
    manifests: once(() => loadManifests(inputs.root, view.nodes)),
    ancestor: (id, kind) => {
      const memo = kind === "mod" ? modOf : sysOf;
      if (memo.has(id)) return memo.get(id);
      let cur = byId.get(id);
      while (cur && cur.kind !== kind) cur = cur.parent ? byId.get(cur.parent) : undefined;
      memo.set(id, cur?.id);
      return cur?.id;
    },
    exportsOf: (rel) => {
      let names = exportsByFile.get(rel);
      if (!names) {
        names = new Set((children.get(`file:${rel}`) ?? []).filter((x) => x.kind === "sym").map((x) => x.label));
        exportsByFile.set(rel, names);
      }
      return names;
    },
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

  /**
   * A list sentence: `key` with `{list}` = the items, each followed by its
   * citation; merged by name, first cite kept. Only the items it names (the
   * first EXPLAIN_LIST names) add their nodes and edges: a system's 2000
   * symbols stay "and 1994 more", not 2000 highlighted nodes.
   */
  list(key: ExplainKey, items: Item[], params: Record<string, string | number> = {}): void {
    const seen = new Map<string, Item>();
    for (const i of items) if (!seen.has(i.name)) seen.set(i.name, i);
    const uniq = [...seen.values()];
    if (!uniq.length) return;
    const named = new Set(uniq.slice(0, EXPLAIN_LIST).map((i) => i.name));
    for (const i of items) {
      if (!named.has(i.name)) continue;
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
    // A module slice shares its module's label: its qualifier tells them apart.
    const label = n.slice ? `${n.label} ${n.slice.qualifier}` : n.label;
    if (this.dev) {
      if (n.kind === "file") return `\`${fileOfId(n.id)}\``;
      if (n.kind === "cap" || n.kind === "sys") return label;
      return `\`${label}\``;
    }
    return n.kind === "sym" || n.kind === "file" ? this.place(n) : label;
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

/** A file in plain words: its stem humanized (`order-history.ts` → `Order history`), its folder's for an index file. */
function fileWords(rel: string): string {
  const parts = rel.split("/");
  const stem = parts[parts.length - 1]!.replace(/\.[^.]+$/, "");
  const generic = /^(index|main|mod|__init__|__main__|init)$/i.test(stem) && parts.length > 1;
  return humanizeSegment(generic ? parts[parts.length - 2]! : stem);
}

/** A file named by the mode: its path in dev, plain words in business. */
function fileItem(w: Writer, rel: string): Item | undefined {
  const cite = w.cite(rel, 1);
  if (!cite) return undefined;
  return { name: w.dev ? `\`${rel}\`` : fileWords(rel), cite, node: `file:${rel}` };
}

const byPagerank = (a: ViewNode, b: ViewNode) => b.metrics.pagerank - a.metrics.pagerank || cmp(a.id, b.id);

/** The code files among `files`, or all of them when none is code (a group of docs or configs). */
function codeFirst(files: ViewNode[]): ViewNode[] {
  const code = files.filter((f) => f.tags.includes("code"));
  return code.length ? code : files;
}

/** A system's or a capability's main modules, by PageRank, each cited at its most central file of the group. */
function mainModules(w: Writer, n: ViewNode, files: ViewNode[]): void {
  const byMod = new Map<string, ViewNode[]>();
  for (const f of codeFirst(files)) if (f.parent && w.ctx.byId.get(f.parent)?.kind === "mod") push(byMod, f.parent, f);
  // A system ranks its modules by their own PageRank; a capability by the PageRank of its files in each.
  const score = (id: string) => (n.kind === "sys" ? w.ctx.byId.get(id)!.metrics.pagerank : byMod.get(id)!.reduce((k, f) => k + f.metrics.pagerank, 0));
  const items = [...byMod.keys()]
    .sort((a, b) => score(b) - score(a) || cmp(a, b))
    .flatMap((id): Item[] => {
      const top = [...byMod.get(id)!].sort(byPagerank)[0]!;
      const cite = w.cite(fileOfId(top.id)!, 1);
      return cite ? [{ name: w.name(w.ctx.byId.get(id)!), cite, node: id }] : [];
    });
  w.list("rel.mainModules", items);
}

/** `target` (a manifest path, or a Python `module:function`) as a file of the group, when it is one. */
function entryFile(dir: string, target: string, has: (rel: string) => boolean): string | undefined {
  const at = (p: string) => posix.normalize(dir ? `${dir}/${p}` : p).replace(/^\.\//, "");
  const tries: string[] = [];
  if (/^[\w.]+:[\w.]+$/.test(target)) {
    const mod = target.split(":")[0]!.replace(/\./g, "/");
    tries.push(at(`${mod}.py`), at(`src/${mod}.py`), at(`${mod}/__init__.py`), at(`src/${mod}/__init__.py`));
  } else {
    const base = at(target);
    if (base.startsWith("..")) return undefined;
    const prefix = dir ? `${dir}/` : "";
    const rest = base.startsWith(prefix) ? base.slice(prefix.length) : base;
    for (const p of [base, `${prefix}${rest.replace(/^(dist|build|out|lib)\//, "src/")}`]) {
      tries.push(p);
      const stem = p.replace(/\.[cm]?[jt]sx?$/, "");
      for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) tries.push(`${stem}${ext}`);
    }
  }
  return tries.find(has);
}

/**
 * Where the group starts: the bin commands, main file and scripts of a
 * manifest it holds (all of them in dev), or of a manifest above it (only the
 * ones starting one of its files); in dev, also its CLI-shaped files.
 */
function entryPoints(w: Writer, files: ViewNode[], all: ViewNode[]): void {
  const own = new Set(all.map((f) => fileOfId(f.id)!));
  const code = new Set(files.filter((f) => f.tags.includes("code")).map((f) => fileOfId(f.id)!));
  const has = (rel: string) => code.has(rel);
  const dirs = new Set<string>();
  for (const rel of code) for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) dirs.add(rel.slice(0, i));
  const bins: Item[] = [];
  const mains: Item[] = [];
  const started: Item[] = [];
  const scripts: Item[] = [];
  for (const m of w.ctx.manifests()) {
    const owned = own.has(m.rel);
    if (!owned && m.dir && !dirs.has(m.dir)) continue;
    for (const e of m.entries) {
      const cite = w.cite(m.rel, e.line);
      if (!cite) continue;
      const file = e.target !== undefined ? entryFile(m.dir, e.target, has) : undefined;
      const node = file ? `file:${file}` : undefined;
      if (e.kind === "bin" && (owned || file))
        bins.push({ name: w.t(w.dev ? "entry.bin.dev" : "entry.bin.business", { name: e.name }), cite, ...(node ? { node } : {}) });
      else if (e.kind === "main" && w.dev && (owned || file))
        mains.push({ name: w.t("entry.main", { name: file ?? e.name }), cite, ...(node ? { node } : {}) });
      else if (e.kind === "script") {
        const runs = (e.command ?? "")
          .split(/\s+/)
          .map((tok) => tok.replace(/^["']|["']$/g, ""))
          .map((tok) => posix.normalize(m.dir ? `${m.dir}/${tok}` : tok))
          .find(has);
        // Business words: a script counts when it starts one of the group's files; dev lists the package's other scripts too.
        if (!runs && (!owned || !w.dev)) continue;
        const item = { name: w.t(w.dev ? "entry.script.dev" : "entry.script.business", { name: e.name }), cite, ...(runs ? { node: `file:${runs}` } : {}) };
        (runs ? started : scripts).push(item);
      }
    }
  }
  const cli: Item[] = [];
  if (w.dev) {
    const named = new Set([...bins, ...mains].map((i) => i.node));
    for (const rel of [...code].sort(cmp)) {
      const base = rel.slice(rel.lastIndexOf("/") + 1);
      if (named.has(`file:${rel}`) || !(/^(cli|main|__main__)\.\w+$/.test(base) || /(^|\/)bin\//.test(rel))) continue;
      const item = fileItem(w, rel);
      if (item) cli.push(item);
    }
  }
  w.list(w.dev ? "rel.entries" : "rel.entries.business", [...bins, ...mains, ...started, ...cli, ...scripts]);
}

/**
 * Where a file-level edge rests: the call to the target (a call site of one of
 * its exports, a route call, a job), else the importing file. Between two
 * capabilities (`caps`), files are often shared: only a call from a member of
 * the one to a member of the other counts, and there is no file fallback.
 */
function edgeEvidence(w: Writer, e: ViewEdge, caps?: { from: string; to: string }): { cite: string; precise: boolean } | undefined {
  if (!e.from.startsWith("file:")) return undefined;
  const fa = e.from.slice("file:".length);
  const fromOk = (line: number) => !caps || !!w.holderAt(fa, line)?.caps.includes(caps.from);
  const toOk = (n: ViewNode | undefined) => !caps || !!n?.caps.includes(caps.to);
  const at = (file: string, line: number | undefined) => {
    const cite = line !== undefined ? w.cite(file, line) : undefined;
    return cite ? { cite, precise: true } : undefined;
  };
  const first = (lines: number[]) => (lines.length ? Math.min(...lines) : undefined);
  if (e.to.startsWith("route:")) {
    if (!toOk(w.ctx.byId.get(e.to))) return undefined;
    return at(fa, first((w.ctx.callsByFile.get(fa) ?? []).filter((c) => c.route === e.to && fromOk(c.line)).map((c) => c.line)));
  }
  if (e.to.startsWith("job:")) {
    const j = w.ctx.jobFacts.get(e.to);
    return j && toOk(w.ctx.byId.get(e.to)) ? at(j.file, j.line) : undefined;
  }
  if (!e.to.startsWith("file:")) return undefined;
  const fb = e.to.slice("file:".length);
  const names = w.ctx.exportsOf(fb);
  const lines: number[] = [];
  if (names.size)
    for (const s of w.ctx.callSites().get(fa) ?? []) {
      const name = names.has(s.name) ? s.name : s.receiver !== undefined && names.has(s.receiver) ? s.receiver : undefined;
      if (name === undefined || !fromOk(s.line)) continue;
      if (caps && !(w.ctx.symsByName.get(name) ?? []).some((x) => x.parent === e.to && toOk(x))) continue;
      lines.push(s.line);
    }
  const call = at(fa, first(lines));
  if (call || caps) return call;
  const head = w.cite(fa, 1);
  return head ? { cite: head, precise: false } : undefined;
}

/**
 * The systems / modules / capabilities this one depends on and that depend on
 * it (the view's rolled-up edges between nodes of its kind), each cited at the
 * evidence of a file-level edge underneath.
 */
function dependencies(w: Writer, n: ViewNode, files: ViewNode[]): void {
  const level = n.kind as "sys" | "mod" | "cap";
  const peers = (edges: ViewEdge[] | undefined, key: "from" | "to") => {
    const m = new Map<string, { weight: number; kind: ViewEdgeKind; top: number }>();
    for (const e of edges ?? []) {
      const other = e[key];
      if (!e.derived || other === n.id || other === FOUNDATIONS_CAP || kindOf(other) !== level || !w.ctx.byId.has(other)) continue;
      const cur = m.get(other) ?? { weight: 0, kind: e.kind, top: 0 };
      cur.weight += e.weight;
      if (e.weight > cur.top) Object.assign(cur, { kind: e.kind, top: e.weight });
      m.set(other, cur);
    }
    return m;
  };
  const outs = peers(w.ctx.out.get(n.id), "to");
  const ins = peers(w.ctx.inn.get(n.id), "from");
  if (!outs.size && !ins.size) return;
  const lift = (id: string): string[] => {
    if (level === "cap") return w.ctx.byId.get(id)?.caps ?? [];
    const up = w.ctx.ancestor(id, level);
    return up ? [up] : [];
  };
  type Ev = { cite: string; precise: boolean };
  const outEv = new Map<string, Ev>();
  const inEv = new Map<string, Ev>();
  const offer = (found: Map<string, Ev>, other: string, e: ViewEdge, out: boolean) => {
    if (found.get(other)?.precise) return;
    const ev = edgeEvidence(w, e, level === "cap" ? (out ? { from: n.id, to: other } : { from: other, to: n.id }) : undefined);
    if (ev && (ev.precise || !found.has(other))) found.set(other, ev);
  };
  for (const f of files) {
    if (outs.size) for (const e of w.ctx.out.get(f.id) ?? []) for (const t of lift(e.to)) if (outs.has(t)) offer(outEv, t, e, true);
    if (!ins.size) continue;
    for (const m of [f, ...(w.ctx.children.get(f.id) ?? [])]) {
      for (const e of w.ctx.inn.get(m.id) ?? []) {
        if (!e.from.startsWith("file:") || w.ctx.byId.get(e.from)?.tags.includes("test")) continue;
        for (const t of lift(e.from)) if (ins.has(t)) offer(inEv, t, e, false);
      }
    }
  }
  const items = (side: Map<string, { weight: number; kind: ViewEdgeKind }>, found: Map<string, Ev>, out: boolean): Item[] =>
    [...side.entries()]
      .sort((a, b) => b[1].weight - a[1].weight || cmp(a[0], b[0]))
      .flatMap(([other, { kind }]): Item[] => {
        const ev = found.get(other);
        if (!ev) return [];
        const edge = out ? w.edge(n.id, other, kind) : w.edge(other, n.id, kind);
        // Modules of different systems often share a label (`Src`): the other one's system tells them apart.
        const sys = level === "mod" ? w.ctx.ancestor(other, "sys") : undefined;
        const where = sys && sys !== w.ctx.ancestor(n.id, "sys") && !w.ctx.byId.get(other)!.slice ? ` (${w.ctx.byId.get(sys)!.label})` : "";
        return [{ name: `${w.name(w.ctx.byId.get(other)!)}${where}`, cite: ev.cite, node: other, edge }];
      });
  w.list("rel.dependsOn", items(outs, outEv, true));
  w.list("rel.dependedOnBy", items(ins, inEv, false));
}

/** The test files covering the group's files, the ones covering most first. */
function testsOf(w: Writer, files: ViewNode[]): void {
  const covers = new Map<string, number>();
  const map = w.ctx.testsOf();
  for (const f of files) for (const t of map.get(fileOfId(f.id)!) ?? []) covers.set(t, (covers.get(t) ?? 0) + 1);
  const items = [...covers.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .flatMap(([rel]) => {
      const item = fileItem(w, rel);
      return item ? [item] : [];
    });
  w.list(w.dev ? "rel.tests.dev" : "rel.tests.business", items);
}

/** The group's files changed the most in the churn window (when the view measured it). */
function churnOf(w: Writer, files: ViewNode[]): void {
  const items = files
    .filter((f) => f.metrics.churn > 0)
    .sort((a, b) => b.metrics.churn - a.metrics.churn || cmp(a.id, b.id))
    .flatMap((f) => {
      const item = fileItem(w, fileOfId(f.id)!);
      return item ? [item] : [];
    });
  w.list(w.dev ? "rel.churn.dev" : "rel.churn.business", items);
}

/** What a group is made of and leans on: its main parts, entry points, neighbours, tests and recent changes. */
function madeOf(w: Writer, n: ViewNode, files: ViewNode[], all: ViewNode[]): void {
  if (n.kind !== "mod") mainModules(w, n, files);
  else {
    const ranked = [...codeFirst(files)].sort(byPagerank).flatMap((f) => {
      const item = fileItem(w, fileOfId(f.id)!);
      return item ? [item] : [];
    });
    w.list(w.dev ? "rel.files" : "rel.mainParts", ranked);
  }
  entryPoints(w, files, all);
  dependencies(w, n, files);
  testsOf(w, files);
  churnOf(w, files);
}

/** Module, system or capability: what its files declare and use, then what it is made of. */
function explainGroup(w: Writer, n: ViewNode): void {
  const nodes = w.ctx.view.nodes;
  let all: ViewNode[];
  if (n.kind === "cap") {
    all = nodes.filter((x) => x.kind === "file" && x.caps.includes(n.id));
  } else if (n.kind === "sys") {
    const mods = new Set((w.ctx.children.get(n.id) ?? []).map((m) => m.id));
    all = nodes.filter((x) => x.kind === "file" && x.parent !== undefined && mods.has(x.parent));
  } else all = (w.ctx.children.get(n.id) ?? []).filter((x) => x.kind === "file");
  // A group of tests only (a test module) is told by its test files.
  const code = all.filter((f) => !f.tags.includes("test"));
  const files = code.length ? code : all;
  if (n.kind === "cap") {
    // A capability's own members (claimed, or inherited from a claimed file), and the uses inside them.
    const declared = nodes.filter((x) => x.caps.includes(n.id) && x.kind !== "file" && x.kind !== "mod" && x.kind !== "sys");
    explainFiles(w, n, files, declared, (h) => !!h && h.caps.includes(n.id));
  } else
    explainFiles(
      w,
      n,
      files,
      files.flatMap((f) => w.ctx.children.get(f.id) ?? []),
    );
  madeOf(w, n, files, all);
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
    escalate: proseCount === 0 && w.facts < (n.kind === "sys" || n.kind === "mod" || n.kind === "cap" ? ESCALATE_GROUP_FACTS : ESCALATE_FACTS),
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
