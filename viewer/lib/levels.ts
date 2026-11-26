// Semantic zoom (docs/design.md §8): what the map draws at each level, as a
// pure "scene" (nodes with sizes, containers, edges) that the layout engine
// places and the SVG renderer draws.
//
//   biz   capabilities + actors, with entities / externals / infra as chips
//   sys   systems
//   mod   modules (grouped in their system)
//   file  files (grouped in their module; a file expands in place to its symbols)
//   sym   symbols, routes, screens, jobs (grouped in their file)
//
// Edges come pre-rolled-up in view.json (one set per level, chosen by the kinds
// of their endpoints); the browser never re-aggregates the whole graph. It only
// re-points an endpoint at its nearest drawn ancestor (a route at its file, a
// file at its cluster) and merges parallel edges of different kinds into one
// drawn line. A level with more than CLUSTER_LIMIT members is drawn as one
// cluster per parent, with a "show all" affordance.

import { type AnyKind, anyKindOf, type Index, type XEdge, type XEdgeKind, type XNode } from "./data.js";

export const LEVELS = ["biz", "sys", "mod", "file", "sym"] as const;
export type Level = (typeof LEVELS)[number];

export const AUDIENCES = ["business", "developer"] as const;
export type ViewerAudience = (typeof AUDIENCES)[number];

/** Past this many members a level is drawn as clusters. */
export const CLUSTER_LIMIT = 250;
/**
 * Lines drawn per scene, at most (unless show all): layered layout time grows
 * with edges far faster than with nodes, and past a few hundred lines a map is
 * a hairball anyway. Every node keeps its strongest line first.
 */
export const EDGE_LIMIT = 300;
/** Neighbours outside a focused node drawn as ghosts, at most. */
export const GHOST_LIMIT = 24;

export interface MapState {
  level: Level;
  /** The node drilled into (its children are the members). */
  focus?: string;
  /** Files expanded in place (file level). */
  expanded?: string[];
  /** Draw every member even past CLUSTER_LIMIT. */
  showAll?: boolean;
}

export const PRIMARY: Record<Level, readonly AnyKind[]> = {
  biz: ["cap", "actor"],
  sys: ["sys"],
  mod: ["mod"],
  file: ["file"],
  sym: ["sym", "route", "screen", "job"],
};

/** Business objects drawn at every level next to the code they touch. */
export const FREE_KINDS: readonly AnyKind[] = ["entity", "ext", "infra"];
const FREE = new Set<AnyKind>(FREE_KINDS);
const LEAF_KINDS = new Set<AnyKind>(["sym", "route", "screen", "job"]);

/** Endpoint kinds of the edges each level draws. */
const EDGE_KINDS: Record<Level, ReadonlySet<AnyKind>> = {
  biz: new Set<AnyKind>(["cap", "actor", ...FREE_KINDS]),
  sys: new Set<AnyKind>(["sys", ...FREE_KINDS]),
  mod: new Set<AnyKind>(["mod", ...FREE_KINDS]),
  file: new Set<AnyKind>(["file", "sym", "route", "screen", "job", ...FREE_KINDS]),
  sym: new Set<AnyKind>(["file", "sym", "route", "screen", "job", ...FREE_KINDS]),
};

/** Levels the audience can open (Business hides files and symbols). */
export function levelsFor(audience: ViewerAudience): Level[] {
  return audience === "business" ? ["biz", "sys", "mod"] : [...LEVELS];
}

export type SceneRole = "card" | "chip" | "ghost" | "cluster" | "group";

export interface SceneNode {
  /** Scene id: the node id, or `cluster:<parent id>` for a cluster. */
  id: string;
  /** The view-model node it stands for (the parent, for a cluster). */
  ref: string;
  role: SceneRole;
  kind: AnyKind;
  label: string;
  /** Containing group (scene id), if any. */
  parent?: string;
  /** Members a cluster stands for. */
  count?: number;
  /** Fields drawn (ERD). */
  rows?: number;
  w: number;
  h: number;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  /** Dominant kind (styles the line). */
  kind: XEdgeKind | "step";
  kinds: (XEdgeKind | "step")[];
  weight: number;
  label?: string;
}

export interface Scene {
  key: string;
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Members of the level before clustering. */
  total: number;
  /** Lines before EDGE_LIMIT kept the strongest. */
  edgesTotal: number;
  clustered: boolean;
  /** View-model id → scene id it is drawn as (members, clusters, groups, ghosts). */
  drawnAs: Map<string, string>;
}

export const SIZE: Record<Exclude<SceneRole, "group">, { w: number; h: number }> = {
  card: { w: 216, h: 64 },
  chip: { w: 164, h: 34 },
  ghost: { w: 184, h: 40 },
  cluster: { w: 216, h: 64 },
};

/** Which kind wins when several edge kinds join the same two nodes. */
const KIND_PRIORITY: (XEdgeKind | "step")[] = ["step", "http", "event", "queue", "data", "call", "extends", "uses", "config", "import", "contains"];

export function dominantKind(kinds: Iterable<XEdgeKind | "step">): XEdgeKind | "step" {
  let best: XEdgeKind | "step" = "import";
  let rank = Number.POSITIVE_INFINITY;
  for (const k of kinds) {
    const r = KIND_PRIORITY.indexOf(k);
    if (r !== -1 && r < rank) {
      rank = r;
      best = k;
    }
  }
  return best;
}

export function sceneKey(s: MapState, audience: ViewerAudience): string {
  return [s.level, s.focus ?? "", [...(s.expanded ?? [])].sort().join(","), s.showAll ? "all" : "", audience].join("|");
}

const levelEdgeCache = new WeakMap<Index, Map<Level, XEdge[]>>();

/** The edges a level draws: both endpoints of a kind the level knows (pre-rolled in view.json). */
export function levelEdges(ix: Index, level: Level): XEdge[] {
  let perLevel = levelEdgeCache.get(ix);
  if (!perLevel) levelEdgeCache.set(ix, (perLevel = new Map()));
  let list = perLevel.get(level);
  if (!list) {
    const kinds = EDGE_KINDS[level];
    list = ix.edges.filter((e) => {
      const a = anyKindOf(e.from);
      const b = anyKindOf(e.to);
      return !!a && !!b && kinds.has(a) && kinds.has(b) && e.kind !== "contains";
    });
    perLevel.set(level, list);
  }
  return list;
}

const byLabel = (a: XNode, b: XNode) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function isUnder(ix: Index, id: string, ancestor: string): boolean {
  let cur = ix.byId.get(id);
  let guard = 0;
  while (cur?.parent && guard++ < 16) {
    if (cur.parent === ancestor) return true;
    cur = ix.byId.get(cur.parent);
  }
  return false;
}

/** The nodes a level shows as its members (before clustering). */
export function levelMembers(ix: Index, s: MapState): XNode[] {
  const kinds = new Set(PRIMARY[s.level]);
  const focus = s.focus ? ix.byId.get(s.focus) : undefined;
  let list: XNode[];
  if (!focus) list = ix.nodes.filter((n) => kinds.has(n.kind));
  else if (focus.kind === "cap") list = (ix.capMembers.get(focus.id) ?? []).map((id) => ix.byId.get(id)!).filter((n) => kinds.has(n.kind));
  else list = ix.nodes.filter((n) => kinds.has(n.kind) && isUnder(ix, n.id, focus.id));
  return list.sort(byLabel);
}

function kindRank(k: AnyKind): number {
  return ["cap", "actor", "sys", "mod", "file", "route", "screen", "job", "sym", "entity", "ext", "infra"].indexOf(k);
}

function sizeOf(role: Exclude<SceneRole, "group">) {
  return { ...SIZE[role] };
}

/** Build the scene of a map state. Pure: same index and state, same scene. */
export function buildScene(ix: Index, s: MapState, audience: ViewerAudience): Scene {
  const key = sceneKey(s, audience);
  const members = levelMembers(ix, s);
  const nodes = new Map<string, SceneNode>();
  const drawnAs = new Map<string, string>();
  const add = (n: SceneNode) => {
    nodes.set(n.id, n);
    drawnAs.set(n.ref, n.id);
  };
  const focus = s.focus ? ix.byId.get(s.focus) : undefined;

  // --- members, or clusters of them --------------------------------------------
  let clustered = false;
  if (members.length > CLUSTER_LIMIT && !s.showAll) {
    clustered = true;
    const clusterBy = (depth: number) => {
      const groups = new Map<string, XNode[]>();
      for (const m of members) {
        let p: string | undefined = m.parent;
        for (let i = 1; i < depth && p; i++) p = ix.byId.get(p)?.parent ?? p;
        const k = p ?? "";
        const g = groups.get(k);
        if (g) g.push(m);
        else groups.set(k, [m]);
      }
      return groups;
    };
    let groups = clusterBy(1);
    if (groups.size > CLUSTER_LIMIT) groups = clusterBy(2);
    for (const [parent, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
      if (list.length === 1 || !parent) {
        for (const m of list) add({ id: m.id, ref: m.id, role: "card", kind: m.kind, label: m.label, ...sizeOf("card") });
        continue;
      }
      const p = ix.byId.get(parent);
      const id = `cluster:${parent}`;
      nodes.set(id, { id, ref: parent, role: "cluster", kind: p?.kind ?? list[0]!.kind, label: p?.label ?? parent, count: list.length, ...sizeOf("cluster") });
      for (const m of list) drawnAs.set(m.id, id);
      if (!drawnAs.has(parent)) drawnAs.set(parent, id);
    }
  } else {
    for (const m of members) add({ id: m.id, ref: m.id, role: "card", kind: m.kind, label: m.label, ...sizeOf("card") });
  }

  // --- groups: members inside their parent's box --------------------------------
  if (!clustered) {
    const groupParent = (m: XNode): string | undefined => {
      if (s.level === "mod" && focus?.kind !== "sys") return m.parent;
      if (s.level === "file" && focus?.kind !== "mod") return m.parent;
      if (s.level === "sym") return m.parent;
      return undefined;
    };
    const parents = new Set<string>();
    for (const m of members) {
      const p = groupParent(m);
      if (p && ix.byId.has(p)) parents.add(p);
    }
    if (parents.size >= 2 || (s.level === "sym" && parents.size >= 1)) {
      for (const p of [...parents].sort()) {
        const pn = ix.byId.get(p)!;
        add({ id: p, ref: p, role: "group", kind: pn.kind, label: pn.label, w: 0, h: 0 });
      }
      for (const m of members) {
        const p = groupParent(m);
        const n = nodes.get(m.id);
        if (p && n && parents.has(p)) n.parent = p;
      }
    }
    // Files expanded in place: the file becomes a box holding its symbols, routes, screens, jobs.
    if (s.level === "file") {
      for (const f of s.expanded ?? []) {
        const card = nodes.get(f);
        if (card?.role !== "card") continue;
        const kids = (ix.children.get(f) ?? []).map((id) => ix.byId.get(id)!).filter((k) => LEAF_KINDS.has(k.kind));
        if (!kids.length) continue;
        card.role = "group";
        card.w = 0;
        card.h = 0;
        for (const k of kids.sort(byLabel)) add({ id: k.id, ref: k.id, role: "card", kind: k.kind, label: k.label, parent: f, ...sizeOf("card") });
      }
    }
  }

  // Business level: every entity, external and infra piece as a chip.
  if (s.level === "biz") {
    for (const n of ix.nodes)
      if (FREE.has(n.kind) && !nodes.has(n.id)) add({ id: n.id, ref: n.id, role: "chip", kind: n.kind, label: n.label, ...sizeOf("chip") });
  }

  // --- edges ---------------------------------------------------------------------
  // Kinds an outside neighbour is drawn as (a ghost): the level's own, plus files around a file's symbols.
  const primary = new Set<AnyKind>([...PRIMARY[s.level], ...(s.level === "sym" ? (["file"] as const) : [])]);
  /** Where an id is drawn, walking up to the nearest drawn ancestor. */
  const resolve = (id: string): string | undefined => {
    // Entities, externals and infra stand for themselves: never drawn as the file that declares them.
    if (FREE.has(anyKindOf(id)!)) return drawnAs.get(id);
    let cur: string | undefined = id;
    let guard = 0;
    while (cur && guard++ < 16) {
      const d = drawnAs.get(cur);
      if (d) return d;
      cur = ix.byId.get(cur)?.parent;
    }
    return undefined;
  };
  /** The node an undrawn endpoint would be drawn as: itself if free, else its nearest ancestor of a member kind. */
  const candidate = (id: string): XNode | undefined => {
    const n = ix.byId.get(id);
    if (!n) return undefined;
    if (FREE.has(n.kind)) return n;
    let cur: XNode | undefined = n;
    let guard = 0;
    while (cur && guard++ < 16) {
      if (primary.has(cur.kind)) return cur;
      cur = cur.parent ? ix.byId.get(cur.parent) : undefined;
    }
    return undefined;
  };

  const raw = levelEdges(ix, s.level);
  const freeFree = (e: XEdge) => FREE.has(anyKindOf(e.from)!) && FREE.has(anyKindOf(e.to)!);
  // Pass 1: which outside nodes join (free chips, ghosts), by summed weight.
  const extra = new Map<string, { node: XNode; weight: number }>();
  for (const e of raw) {
    if (freeFree(e)) continue;
    const a = resolve(e.from);
    const b = resolve(e.to);
    if (a && b) continue;
    if (!a && !b) continue;
    const c = candidate(a ? e.to : e.from);
    if (!c || c.id === focus?.id) continue;
    if (!FREE.has(c.kind) && !focus) continue; // unfocused levels already hold every member
    const acc = extra.get(c.id) ?? { node: c, weight: 0 };
    acc.weight += e.weight;
    extra.set(c.id, acc);
  }
  const ranked = [...extra.values()].sort((x, y) => y.weight - x.weight || (x.node.id < y.node.id ? -1 : 1));
  let ghosts = 0;
  for (const { node } of ranked) {
    if (FREE.has(node.kind)) add({ id: node.id, ref: node.id, role: "chip", kind: node.kind, label: node.label, ...sizeOf("chip") });
    else if (ghosts < GHOST_LIMIT) {
      ghosts++;
      add({ id: node.id, ref: node.id, role: "ghost", kind: node.kind, label: node.label, ...sizeOf("ghost") });
    }
  }
  // Pass 2: draw, merging parallel edges of different kinds.
  type Acc = { from: string; to: string; kinds: Set<XEdgeKind>; weight: number; labels: Set<string> };
  const merged = new Map<string, Acc>();
  for (const e of raw) {
    if (freeFree(e)) continue; // relations between entities belong to the Data view
    const a = resolve(e.from);
    const b = resolve(e.to);
    if (!a || !b || a === b) continue;
    // Never draw an edge between a box and what it holds.
    if (nodes.get(b)?.parent === a || nodes.get(a)?.parent === b) continue;
    const k = `${a}\n${b}`;
    const acc = merged.get(k) ?? { from: a, to: b, kinds: new Set(), weight: 0, labels: new Set() };
    acc.kinds.add(e.kind);
    acc.weight += e.weight;
    if (e.label && a === e.from && b === e.to) acc.labels.add(e.label);
    merged.set(k, acc);
  }
  const edges: SceneEdge[] = [...merged.values()]
    .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0))
    .map((m) => {
      const kinds = [...m.kinds].sort((p, q) => KIND_PRIORITY.indexOf(p) - KIND_PRIORITY.indexOf(q));
      return {
        id: `${m.from}->${m.to}`,
        from: m.from,
        to: m.to,
        kind: dominantKind(kinds),
        kinds,
        weight: m.weight,
        ...(m.labels.size === 1 ? { label: [...m.labels][0] } : {}),
      };
    });

  const kept = s.showAll ? edges : strongest(edges, EDGE_LIMIT);
  const ordered = [...nodes.values()].sort((a, b) => {
    const ra = a.role === "group" ? 0 : 1;
    const rb = b.role === "group" ? 0 : 1;
    return ra - rb || kindRank(a.kind) - kindRank(b.kind) || (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1);
  });
  return { key, nodes: ordered, edges: kept, total: members.length, edgesTotal: edges.length, clustered, drawnAs };
}

/** At most `limit` edges: each node's strongest first, then by weight; original order kept. */
export function strongest(edges: readonly SceneEdge[], limit: number): SceneEdge[] {
  if (edges.length <= limit) return [...edges];
  const byWeight = [...edges].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keep = new Set<string>();
  const touched = new Set<string>();
  for (const e of byWeight) {
    if (keep.size >= limit) break;
    if (!touched.has(e.from) || !touched.has(e.to)) {
      keep.add(e.id);
      touched.add(e.from);
      touched.add(e.to);
    }
  }
  for (const e of byWeight) {
    if (keep.size >= limit) break;
    keep.add(e.id);
  }
  return edges.filter((e) => keep.has(e.id));
}

/** The scene id a view-model node is drawn as (itself, its cluster, its box), if drawn. */
export function locate(ix: Index, scene: Scene, id: string): string | undefined {
  if (FREE.has(anyKindOf(id)!)) return scene.drawnAs.get(id);
  let cur: string | undefined = id;
  let guard = 0;
  while (cur && guard++ < 16) {
    const d = scene.drawnAs.get(cur);
    if (d) return d;
    cur = ix.byId.get(cur)?.parent;
  }
  return undefined;
}

/**
 * A scene of exactly these nodes (a lens, a flow), with the view-model edges
 * among them plus extra ones (the lens's own edges, a flow's steps).
 */
export function subgraphScene(
  ix: Index,
  key: string,
  ids: readonly string[],
  extra: readonly { from: string; to: string; kind?: XEdgeKind | "step"; label?: string }[] = [],
): Scene {
  const nodes: SceneNode[] = [];
  const drawnAs = new Map<string, string>();
  for (const id of ids) {
    if (drawnAs.has(id)) continue;
    const n = ix.byId.get(id);
    if (!n) continue;
    const role = FREE.has(n.kind) || n.kind === "actor" ? "chip" : "card";
    nodes.push({ id, ref: id, role, kind: n.kind, label: n.label, ...sizeOf(role) });
    drawnAs.set(id, id);
  }
  const merged = new Map<string, { from: string; to: string; kinds: Set<XEdgeKind | "step">; weight: number; label?: string }>();
  const addEdge = (from: string, to: string, kind: XEdgeKind | "step", weight: number, label?: string) => {
    if (from === to || !drawnAs.has(from) || !drawnAs.has(to)) return;
    const k = `${from}\n${to}`;
    const acc = merged.get(k) ?? { from, to, kinds: new Set(), weight: 0 };
    acc.kinds.add(kind);
    acc.weight += weight;
    if (label) acc.label = label;
    merged.set(k, acc);
  };
  for (const e of extra) addEdge(e.from, e.to, e.kind ?? "call", 1, e.label);
  const inside = new Set(drawnAs.keys());
  for (const id of inside) for (const e of ix.out.get(id) ?? []) if (inside.has(e.to) && e.kind !== "contains") addEdge(e.from, e.to, e.kind, e.weight);
  const edges: SceneEdge[] = [...merged.values()].map((m) => {
    const kinds = [...m.kinds].sort((p, q) => KIND_PRIORITY.indexOf(p) - KIND_PRIORITY.indexOf(q));
    return { id: `${m.from}->${m.to}`, from: m.from, to: m.to, kind: dominantKind(kinds), kinds, weight: m.weight, ...(m.label ? { label: m.label } : {}) };
  });
  return { key, nodes, edges, total: nodes.length, edgesTotal: edges.length, clustered: false, drawnAs };
}

/** Fields an ERD card lists before "+ n more". */
export const ERD_MAX_FIELDS = 12;
export const ERD_ROW = 20;
export const ERD_HEAD = 36;

/** The Data view: every entity with its fields, relations merged per pair. */
export function erdScene(ix: Index): Scene {
  const entities = ix.nodes.filter((n) => n.kind === "entity").sort(byLabel);
  const nodes: SceneNode[] = [];
  const drawnAs = new Map<string, string>();
  for (const e of entities) {
    const fields = e.fields?.length ?? 0;
    const rows = Math.min(fields, ERD_MAX_FIELDS) + (fields > ERD_MAX_FIELDS ? 1 : 0);
    nodes.push({ id: e.id, ref: e.id, role: "card", kind: "entity", label: e.label, rows, w: 232, h: ERD_HEAD + rows * ERD_ROW + 8 });
    drawnAs.set(e.id, e.id);
  }
  const pairs = new Map<string, { from: string; to: string; labels: string[]; weight: number }>();
  for (const e of ix.edges) {
    if (e.kind !== "data" || !drawnAs.has(e.from) || !drawnAs.has(e.to) || e.from === e.to) continue;
    const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
    const k = `${a}\n${b}`;
    const acc = pairs.get(k) ?? { from: e.from, to: e.to, labels: [], weight: 0 };
    if (e.label) acc.labels.push(e.label);
    acc.weight += e.weight;
    pairs.set(k, acc);
  }
  const edges: SceneEdge[] = [...pairs.values()]
    .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : 1))
    .map((p) => ({
      id: `${p.from}->${p.to}`,
      from: p.from,
      to: p.to,
      kind: "data" as const,
      kinds: ["data" as const],
      weight: p.weight,
      ...(p.labels.length ? { label: p.labels.join(" · ") } : {}),
    }));
  return { key: "erd", nodes, edges, total: nodes.length, edgesTotal: edges.length, clustered: false, drawnAs };
}
