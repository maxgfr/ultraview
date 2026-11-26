// The view-model (docs/design.md §6): ultraindex graph + symbols, facts,
// model.json, flows, lenses and timeline merged into one `ViewModel`.
//
// `assembleView` is pure over already-loaded inputs (no file system, no clock),
// so two runs over the same inputs produce the same object and, through
// stableJson, the same bytes. Loading lives in ./load.ts.
//
// What it computes:
//   - the structural tree   sys ⊃ mod ⊃ file ⊃ sym/route/screen/job/entity
//   - the capability overlay (every node's `caps`, `cap:_foundations` for the rest)
//   - edges: file-level ones from the graph and facts, then rolled up to
//     module, system and capability level (weight = summed references)
//   - metrics, labels, summaries, coverage and staleness

import { codeindex, type Graph, parseCitations, type SymbolIndex } from "../engine.js";
import type { Facts } from "../extract/types.js";
import {
  APP_SYS,
  capId,
  entityId,
  extId,
  FOUNDATIONS_CAP,
  FOUNDATIONS_LABEL,
  fileId,
  infraId,
  jobId,
  kindOf,
  modId,
  routeId,
  screenId,
  symId,
  sysId,
  UNASSIGNED_LABEL,
  UNASSIGNED_SYS,
} from "./ids.js";
import {
  type ViewEdgeKind,
  type Flow,
  type Lens,
  type Model,
  type ModelSystem,
  type NodeKind,
  type NodeMetrics,
  type TimelineEntry,
  VIEW_SCHEMA,
  type ViewEdge,
  type ViewModel,
  type ViewNode,
} from "./types.js";

/** Symbols kept per file, at most (exported, top-level, by line). */
export const SYMBOLS_PER_FILE = 50;

export interface WorkspaceRef {
  name: string;
  /** Repo-relative dir, posix, "" for the root package. */
  dir: string;
}

export interface ViewInputs {
  repoName: string;
  commit?: string;
  graph: Graph;
  symbols?: SymbolIndex;
  facts: Facts;
  /** A model that passed validation, or undefined (absent or invalid). */
  model?: Model;
  /** Workspace packages: the fallback systems when there is no model. */
  workspaces: WorkspaceRef[];
  flows: Flow[];
  lenses: Lens[];
  timeline: TimelineEntry[];
  /** Module slug → its enriched ultraindex prose (the `business` region). */
  moduleProse: Map<string, string>;
  /** Module slugs whose ultraindex prose is stale. */
  proseStale: string[];
  /** Current sha256 of every path a flow / lens `sources` names; null = file gone. */
  currentHashes: Map<string, string | null>;
}

/** A glob in model.json that matched no indexed file (likely a typo). */
export interface EmptyGlob {
  path: string;
  glob: string;
}

export interface AssembleResult {
  view: ViewModel;
  /** Each view file's own system (from the globs), before the module majority vote. */
  fileSystems: Map<string, string>;
  emptyGlobs: EmptyGlob[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const zeroMetrics = (): NodeMetrics => ({ loc: 0, pagerank: 0, churn: 0, tests: 0 });
const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort(cmp);

/** Plain words from a path segment: `src/order-history` → `Order history`, `(root)` → `Root`. */
export function humanizeSegment(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? path;
  const words = last
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : path;
}

/** How specific a glob is: the length of its literal prefix (before the first wildcard). */
export function globSpecificity(glob: string): number {
  const i = glob.search(/[*?]/);
  return i === -1 ? glob.length : i;
}

/**
 * A matcher for one model glob. A glob without wildcards names a file or a
 * directory: `src/api` matches `src/api` and everything under it.
 */
export function globMatcher(glob: string): (rel: string) => boolean {
  const g = glob.replace(/^\.\//, "").replace(/\/$/, "");
  const globs = /[*?]/.test(g) ? [g] : [g, `${g}/**`];
  return codeindex.compileGlobs(globs) ?? (() => false);
}

/**
 * Each file's system from model.json: the most specific matching glob wins
 * (longest literal prefix), ties by declaration order; a file a system
 * `exclude`s is not that system's. Unmatched files → `sys:_unassigned`.
 */
export function assignSystems(files: readonly string[], systems: readonly ModelSystem[], emptyGlobs?: EmptyGlob[]): Map<string, string> {
  const compiled = systems.map((s) => ({
    id: sysId(s.id),
    paths: s.paths.map((g) => ({ glob: g, match: globMatcher(g), spec: globSpecificity(g), hits: 0 })),
    exclude: s.exclude?.length ? s.exclude.map(globMatcher) : [],
  }));
  const out = new Map<string, string>();
  for (const rel of files) {
    let best: { id: string; spec: number } | undefined;
    for (const sys of compiled) {
      if (sys.exclude.some((m) => m(rel))) continue;
      for (const p of sys.paths) {
        if (!p.match(rel)) continue;
        p.hits++;
        if (!best || p.spec > best.spec) best = { id: sys.id, spec: p.spec };
      }
    }
    out.set(rel, best?.id ?? UNASSIGNED_SYS);
  }
  if (emptyGlobs) {
    systems.forEach((s, i) => {
      compiled[i]!.paths.forEach((p, j) => {
        if (!p.hits) emptyGlobs.push({ path: `systems[${i}].paths[${j}]`, glob: s.paths[j]! });
      });
    });
  }
  return out;
}

/** Systems without a model: one per workspace package (deepest dir wins), else a single `sys:app`. */
function workspaceSystems(files: readonly string[], workspaces: readonly WorkspaceRef[]): { order: { id: string; label: string }[]; of: Map<string, string> } {
  const pkgs = workspaces
    .filter((w) => w.dir)
    .map((w) => ({
      id: sysId(
        w.dir
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "app",
      ),
      label: w.name || w.dir,
      dir: w.dir,
    }))
    .sort((a, b) => cmp(a.dir, b.dir));
  const of = new Map<string, string>();
  if (!pkgs.length) {
    for (const rel of files) of.set(rel, APP_SYS);
    return { order: [{ id: APP_SYS, label: "App" }], of };
  }
  for (const rel of files) {
    let best: (typeof pkgs)[number] | undefined;
    for (const p of pkgs) if ((rel === p.dir || rel.startsWith(`${p.dir}/`)) && (!best || p.dir.length > best.dir.length)) best = p;
    of.set(rel, best?.id ?? UNASSIGNED_SYS);
  }
  return { order: pkgs.map(({ id, label }) => ({ id, label })), of };
}

function citesOf(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set(parseCitations(text).map((c) => c.raw))];
}

/** Map an engine file edge kind onto the view enum; undefined = not a dependency edge. */
function mapEdgeKind(kind: string): ViewEdgeKind | undefined {
  switch (kind) {
    case "import":
    case "use":
      return "import";
    case "call":
      return "call";
    case "extends":
    case "implements":
      return "extends";
    default:
      return undefined;
  }
}

const EXTERNAL_EDGE: Record<string, ViewEdgeKind> = { sdk: "call", host: "http", env: "config" };

/** Nodes that stay themselves at every roll-up level: business things, not code. */
const LEVEL_FREE: ReadonlySet<NodeKind> = new Set<NodeKind>(["entity", "ext", "infra"]);

export function assembleWithNotes(inp: ViewInputs): AssembleResult {
  const { graph, facts, model } = inp;
  const nodes = new Map<string, ViewNode>();
  const add = (n: ViewNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const emptyGlobs: EmptyGlob[] = [];

  // --- files and their systems -------------------------------------------
  const files = graph.files.filter((f) => !f.generated).sort((a, b) => cmp(a.rel, b.rel));
  const rels = files.map((f) => f.rel);
  const testMap = codeindex.computeTestMap(graph);

  let systemOrder: { id: string; label: string; summary?: string; role?: ModelSystem["kind"] }[];
  let fileSystems: Map<string, string>;
  if (model) {
    fileSystems = assignSystems(rels, model.systems, emptyGlobs);
    systemOrder = model.systems.map((s) => ({ id: sysId(s.id), label: s.label, summary: s.summary, role: s.kind }));
  } else {
    const ws = workspaceSystems(rels, inp.workspaces);
    fileSystems = ws.of;
    systemOrder = ws.order;
  }

  // --- modules: parent = the system holding most of their files ----------
  const sysRank = new Map(systemOrder.map((s, i) => [s.id, i]));
  sysRank.set(UNASSIGNED_SYS, systemOrder.length);
  const filesByModule = new Map<string, typeof files>();
  for (const f of files) {
    const list = filesByModule.get(f.module) ?? [];
    list.push(f);
    filesByModule.set(f.module, list);
  }
  const usedSystems = new Set<string>(systemOrder.map((s) => s.id));
  const modules = [...graph.modules].filter((m) => filesByModule.has(m.slug)).sort((a, b) => cmp(a.slug, b.slug));
  const testModules = new Set<string>();
  for (const m of modules) {
    const members = filesByModule.get(m.slug)!;
    const votes = new Map<string, number>();
    for (const f of members) {
      const s = fileSystems.get(f.rel)!;
      votes.set(s, (votes.get(s) ?? 0) + 1);
    }
    let parent = UNASSIGNED_SYS;
    let bestVotes = -1;
    for (const [s, n] of votes) {
      if (n > bestVotes || (n === bestVotes && sysRank.get(s)! < sysRank.get(parent)!)) {
        parent = s;
        bestVotes = n;
      }
    }
    usedSystems.add(parent);
    const codeMembers = members.filter((f) => f.fileKind === "code");
    const isTest = members.every((f) => f.testFile) || (codeMembers.length > 0 && codeMembers.every((f) => f.testFile));
    if (isTest) testModules.add(m.slug);
    const summary = inp.moduleProse.get(m.slug);
    add({
      id: modId(m.slug),
      kind: "mod",
      label: humanizeSegment(m.path),
      parent,
      ...(summary ? { summary } : {}),
      cites: citesOf(summary),
      metrics: {
        loc: members.reduce((n, f) => n + f.lines, 0),
        pagerank: round4(m.pagerank ?? 0),
        churn: 0, // TODO(churn): from git history (codeindex.gitChurn) once `diff` lands.
        tests: m.testedBy?.length ?? 0,
      },
      caps: [],
      tags: uniqSorted([`tier-${m.tier}`, ...(isTest ? ["test"] : [])]),
    });
  }
  for (const rel of rels) usedSystems.add(fileSystems.get(rel)!);

  // --- systems -------------------------------------------------------------
  for (const s of systemOrder) {
    add({
      id: s.id,
      kind: "sys",
      label: s.label,
      ...(s.summary ? { summary: s.summary } : {}),
      cites: citesOf(s.summary),
      metrics: zeroMetrics(),
      caps: [],
      tags: [],
      ...(s.role ? { role: s.role } : {}),
    });
  }
  if (usedSystems.has(UNASSIGNED_SYS)) {
    add({ id: UNASSIGNED_SYS, kind: "sys", label: UNASSIGNED_LABEL, cites: [], metrics: zeroMetrics(), caps: [], tags: ["derived"] });
  }

  // --- files -----------------------------------------------------------------
  for (const f of files) {
    add({
      id: fileId(f.rel),
      kind: "file",
      label: f.rel.split("/").pop() ?? f.rel,
      parent: modId(f.module),
      cites: [],
      metrics: { loc: f.lines, pagerank: round4(f.pagerank ?? 0), churn: 0, tests: testMap.testedByFile.get(f.rel)?.length ?? 0 },
      caps: [],
      tags: uniqSorted([f.fileKind, ...(f.testFile ? ["test"] : [])]),
    });
  }
  const hasFile = (rel: string) => nodes.has(fileId(rel));

  // --- symbols: exported, top-level, at most SYMBOLS_PER_FILE per file -------
  if (inp.symbols) {
    const byFile = new Map<string, { name: string; line: number; endLine?: number; kind: string }[]>();
    for (const [name, defs] of Object.entries(inp.symbols.defs)) {
      for (const d of defs) {
        if (!d.exported || d.parent || !hasFile(d.file)) continue;
        const list = byFile.get(d.file) ?? [];
        list.push({ name, line: d.line, endLine: d.endLine, kind: d.kind });
        byFile.set(d.file, list);
      }
    }
    for (const [rel, defs] of byFile) {
      defs.sort((a, b) => a.line - b.line || cmp(a.name, b.name));
      const seen = new Set<string>();
      const kept = defs
        .filter((d) => {
          if (seen.has(d.name)) return false;
          seen.add(d.name);
          return true;
        })
        .slice(0, SYMBOLS_PER_FILE);
      for (const d of kept) {
        add({
          id: symId(rel, d.name),
          kind: "sym",
          label: d.name,
          parent: fileId(rel),
          cites: [],
          at: `${rel}:${d.line}`,
          metrics: { ...zeroMetrics(), loc: d.endLine ? d.endLine - d.line + 1 : 0 },
          caps: [],
          tags: [d.kind],
        });
      }
    }
  }

  // --- facts -----------------------------------------------------------------
  const factNode = (id: string, kind: NodeKind, label: string, file: string, line: number, tags: string[], extra: Partial<ViewNode> = {}) =>
    add({
      id,
      kind,
      label,
      ...(hasFile(file) && kind !== "ext" && kind !== "infra" ? { parent: fileId(file) } : {}),
      cites: [],
      at: `${file}:${line}`,
      metrics: zeroMetrics(),
      caps: [],
      tags: uniqSorted(tags),
      ...extra,
    });
  for (const r of facts.routes) factNode(routeId(r.method, r.path), "route", `${r.method.toUpperCase()} ${r.path}`, r.file, r.line, [r.framework]);
  for (const s of facts.screens) factNode(screenId(s.path), "screen", s.path, s.file, s.line, [s.framework]);
  for (const e of facts.entities) {
    factNode(entityId(e.name), "entity", e.name, e.file, e.line, [e.orm], {
      fields: e.fields.map((f) => ({ name: f.name, type: f.type, ...(f.relation ? { relation: f.relation } : {}) })),
    });
  }
  for (const j of facts.jobs) factNode(jobId(j.id), "job", j.id, j.file, j.line, [j.kind, ...(j.schedule ? [`schedule:${j.schedule}`] : [])]);
  const extVias = new Map<string, Set<string>>();
  for (const x of facts.externals) {
    factNode(extId(x.id), "ext", x.id, x.file, x.line, []);
    const vias = extVias.get(x.id) ?? new Set();
    vias.add(x.via);
    extVias.set(x.id, vias);
  }
  for (const [id, vias] of extVias) nodes.get(extId(id))!.tags = uniqSorted(vias);
  for (const i of facts.infra) factNode(infraId(i.id), "infra", i.id, i.file, i.line, [i.kind]);

  // --- tree ----------------------------------------------------------------
  const children = new Map<string, string[]>();
  for (const n of nodes.values()) {
    if (!n.parent) continue;
    const list = children.get(n.parent) ?? [];
    list.push(n.id);
    children.set(n.parent, list);
  }
  const descendants = (id: string, out: Set<string>) => {
    for (const c of children.get(id) ?? []) {
      if (out.has(c)) continue;
      out.add(c);
      descendants(c, out);
    }
    return out;
  };

  // --- capabilities overlay ------------------------------------------------
  const caps = new Map<string, Set<string>>();
  const claim = (nodeId: string, cap: string) => {
    const set = caps.get(nodeId) ?? new Set();
    set.add(cap);
    caps.set(nodeId, set);
  };
  for (const [i, c] of (model?.capabilities ?? []).entries()) {
    const id = capId(c.id);
    add({
      id,
      kind: "cap",
      label: c.label,
      ...(c.summary ? { summary: c.summary } : {}),
      cites: citesOf(c.summary),
      metrics: zeroMetrics(),
      caps: [],
      tags: uniqSorted(c.tags ?? []),
      ...(c.actors?.length ? { actors: [...c.actors] } : {}),
    });
    const claimed = new Set<string>();
    for (const m of c.members ?? []) if (nodes.has(m) && kindOf(m) !== "cap") claimed.add(m);
    (c.paths ?? []).forEach((g, j) => {
      const match = globMatcher(g);
      let hits = 0;
      for (const rel of rels) {
        if (!match(rel)) continue;
        hits++;
        claimed.add(fileId(rel));
      }
      if (!hits) emptyGlobs.push({ path: `capabilities[${i}].paths[${j}]`, glob: g });
    });
    // A claim covers the claimed node and everything under it.
    for (const n of claimed) {
      claim(n, id);
      for (const d of descendants(n, new Set())) claim(d, id);
    }
  }
  // Aggregate upward: a node serves what its children serve.
  const aggregated = new Map<string, Set<string>>();
  const capsOf = (id: string): Set<string> => {
    const memo = aggregated.get(id);
    if (memo) return memo;
    const set = new Set(caps.get(id) ?? []);
    aggregated.set(id, set);
    for (const c of children.get(id) ?? []) for (const x of capsOf(c)) set.add(x);
    return set;
  };
  for (const id of nodes.keys()) capsOf(id);

  // Non-test modules no capability claims fall into the shared foundations.
  const foundations = modules.filter((m) => !testModules.has(m.slug) && capsOf(modId(m.slug)).size === 0).map((m) => modId(m.slug));
  if (foundations.length) {
    add({ id: FOUNDATIONS_CAP, kind: "cap", label: FOUNDATIONS_LABEL, cites: [], metrics: zeroMetrics(), caps: [], tags: ["derived"] });
    for (const m of foundations) {
      for (const d of [m, ...descendants(m, new Set())]) {
        if (capsOf(d).size === 0) aggregated.get(d)!.add(FOUNDATIONS_CAP);
      }
      const parent = nodes.get(m)!.parent;
      if (parent) aggregated.get(parent)!.add(FOUNDATIONS_CAP);
    }
  }
  for (const n of nodes.values()) n.caps = n.kind === "cap" ? [] : uniqSorted(aggregated.get(n.id) ?? []);

  // --- metrics of systems and capabilities ---------------------------------
  const fileNodes = [...nodes.values()].filter((n) => n.kind === "file");
  const ancestorOfKind = (id: string, kind: NodeKind): string | undefined => {
    let cur = nodes.get(id);
    while (cur && cur.kind !== kind) cur = cur.parent ? nodes.get(cur.parent) : undefined;
    return cur?.id;
  };
  const rollMetrics = (target: string, f: ViewNode) => {
    const m = nodes.get(target)!.metrics;
    m.loc += f.metrics.loc;
    m.pagerank = round4(m.pagerank + f.metrics.pagerank);
    m.tests += f.metrics.tests;
  };
  for (const f of fileNodes) {
    const sys = ancestorOfKind(f.id, "sys");
    if (sys) rollMetrics(sys, f);
    for (const c of f.caps) rollMetrics(c, f);
  }

  // --- edges -----------------------------------------------------------------
  type Acc = { from: string; to: string; kind: ViewEdgeKind; weight: number; labels: Set<string> };
  const base = new Map<string, Acc>();
  const addBase = (from: string, to: string, kind: ViewEdgeKind, weight: number, label?: string) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const key = `${from}\n${to}\n${kind}`;
    const acc = base.get(key) ?? { from, to, kind, weight: 0, labels: new Set() };
    acc.weight += weight;
    if (label) acc.labels.add(label);
    base.set(key, acc);
  };
  for (const e of graph.fileEdges) {
    const kind = mapEdgeKind(e.kind);
    if (!kind || e.dangling) continue;
    addBase(fileId(e.from), fileId(e.to), kind, e.weight || 1);
  }
  for (const c of facts.calls) if (c.route) addBase(fileId(c.file), c.route, "http", 1);
  for (const u of facts.entityUses) addBase(fileId(u.file), entityId(u.entity), "data", 1, u.op);
  for (const e of facts.entities) {
    for (const f of e.fields) if (f.relation) addBase(entityId(e.name), entityId(f.relation), "data", 1, f.name);
  }
  for (const x of facts.externals) addBase(fileId(x.file), extId(x.id), EXTERNAL_EDGE[x.via] ?? "call", 1);
  for (const j of facts.jobs) {
    const job = nodes.get(jobId(j.id));
    if (job && job.parent !== fileId(j.file)) addBase(fileId(j.file), job.id, "queue", 1);
  }

  // Roll up to module, system and capability level.
  const rolled = new Map<string, Acc>();
  const addRolled = (from: string, to: string, kind: ViewEdgeKind, weight: number) => {
    if (from === to) return;
    const key = `${from}\n${to}\n${kind}`;
    if (base.has(key)) return;
    const acc = rolled.get(key) ?? { from, to, kind, weight: 0, labels: new Set() };
    acc.weight += weight;
    rolled.set(key, acc);
  };
  const lift = (id: string, level: "mod" | "sys" | "cap"): string[] => {
    const kind = kindOf(id)!;
    if (LEVEL_FREE.has(kind) || kind === level) return [id];
    if (level === "cap") return nodes.get(id)!.caps;
    const up = ancestorOfKind(id, level);
    return up ? [up] : [];
  };
  for (const e of base.values()) {
    for (const level of ["mod", "sys", "cap"] as const) {
      const froms = lift(e.from, level);
      const tos = lift(e.to, level);
      for (const f of froms) for (const t of tos) if (f !== e.from || t !== e.to) addRolled(f, t, e.kind, e.weight);
    }
  }

  const edges: ViewEdge[] = [];
  const labelOf = (labels: Set<string>) => (labels.size ? uniqSorted(labels).join("+") : undefined);
  for (const e of base.values()) {
    const label = labelOf(e.labels);
    edges.push({ from: e.from, to: e.to, kind: e.kind, weight: e.weight, derived: true, ...(label ? { label } : {}) });
  }
  for (const e of rolled.values()) edges.push({ from: e.from, to: e.to, kind: e.kind, weight: e.weight, derived: true });
  for (const e of model?.edges ?? []) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    edges.push({
      from: e.from,
      to: e.to,
      kind: e.kind,
      weight: 1,
      derived: false,
      ...(e.label ? { label: e.label } : {}),
      ...(e.cite ? { cite: e.cite } : {}),
    });
  }
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind) || Number(a.derived) - Number(b.derived));

  // --- coverage ----------------------------------------------------------------
  const codeFiles = files.filter((f) => f.fileKind === "code");
  const inSystems = codeFiles.filter((f) => fileSystems.get(f.rel) !== UNASSIGNED_SYS).length;
  const codeModules = modules.filter((m) => !testModules.has(m.slug) && filesByModule.get(m.slug)!.some((f) => f.fileKind === "code" && !f.testFile));
  const inCaps = codeModules.filter((m) => nodes.get(modId(m.slug))!.caps.some((c) => c !== FOUNDATIONS_CAP)).length;
  const ratio = (n: number, d: number) => (d === 0 ? 1 : round4(n / d));

  // --- staleness -----------------------------------------------------------------
  const isStale = (sources: Record<string, string> | undefined) =>
    !!sources && Object.entries(sources).some(([path, hash]) => (inp.currentHashes.get(path) ?? null) !== hash);

  const flows = [...inp.flows].sort((a, b) => cmp(a.id, b.id));
  const lenses = [...inp.lenses].sort((a, b) => cmp(a.id, b.id));

  const view: ViewModel = {
    schema: VIEW_SCHEMA,
    repo: { name: inp.repoName, ...(inp.commit ? { commit: inp.commit } : {}) },
    app: {
      name: model?.app.name ?? inp.repoName,
      ...(model?.app.summary ? { summary: model.app.summary } : {}),
      cites: citesOf(model?.app.summary),
      audience: model?.app.audience ?? "everyone",
    },
    nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
    edges,
    flows,
    lenses,
    timeline: [...inp.timeline],
    changes: null,
    insights: [],
    glossary: [...(model?.glossary ?? [])],
    tour: [...(model?.tour ?? [])],
    coverage: { filesInSystems: ratio(inSystems, codeFiles.length), modulesInCapabilities: ratio(inCaps, codeModules.length) },
    stale: {
      lenses: lenses.filter((l) => isStale(l.sources)).map((l) => l.id),
      flows: flows.filter((f) => isStale(f.sources)).map((f) => f.id),
      prose: uniqSorted(inp.proseStale.map(modId)),
    },
  };
  return { view, fileSystems, emptyGlobs };
}

/** The merged view-model of loaded inputs. Pure: same inputs, same object. */
export function assembleView(inp: ViewInputs): ViewModel {
  return assembleWithNotes(inp).view;
}
