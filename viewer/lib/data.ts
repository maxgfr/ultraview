// The viewer's index over one view.json: lookups by id, the structural tree,
// edges by endpoint, per-node counts, capability colours and the pseudo
// "actor" nodes the Business level draws (a capability's `actors` are strings
// in the view-model, not nodes).
//
// Built once per data load in O(nodes + edges); everything else in the viewer
// reads from here. Pure: no DOM.

import { FOUNDATIONS_CAP, fileOfId, kindOf } from "../../src/model/ids.js";
import type { NodeKind, ViewEdge, ViewEdgeKind, ViewModel, ViewNode } from "../../src/model/types.js";

/** Node kinds of the view-model plus the viewer's own pseudo kind. */
export type AnyKind = NodeKind | "actor";

export interface XNode extends Omit<ViewNode, "kind"> {
  kind: AnyKind;
}

/** Edge kinds of the view-model plus `uses` (actor → capability). */
export type XEdgeKind = ViewEdgeKind | "uses";

export interface XEdge extends Omit<ViewEdge, "kind"> {
  kind: XEdgeKind;
}

export interface Counts {
  sys: number;
  mod: number;
  file: number;
  sym: number;
  route: number;
  screen: number;
  entity: number;
  job: number;
}

export interface Index {
  view: ViewModel;
  nodes: XNode[];
  byId: Map<string, XNode>;
  children: Map<string, string[]>;
  out: Map<string, XEdge[]>;
  in: Map<string, XEdge[]>;
  edges: XEdge[];
  /** Members of each capability (nodes whose `caps` name it). */
  capMembers: Map<string, string[]>;
  counts: Map<string, Counts>;
  /** Capability id → palette slot (0-based), `-1` for Shared foundations. */
  capSlot: Map<string, number>;
  /** Ids of stale lenses / flows. */
  staleLenses: Set<string>;
  staleFlows: Set<string>;
  /** Module id → the directory its files share (repo-relative, "" at the root). */
  dirs: Map<string, string>;
  /** Whether the agent wrote a business map (a capability besides Shared foundations). */
  hasBusiness: boolean;
}

/** How many categorical colours the palette holds (styles.css `--cap-0` … `--cap-7`). */
export const PALETTE_SIZE = 8;

export const actorId = (name: string) => `actor:${name}`;

const zero = (): Counts => ({ sys: 0, mod: 0, file: 0, sym: 0, route: 0, screen: 0, entity: 0, job: 0 });

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The kind of any id the viewer handles, pseudo kinds included. */
export function anyKindOf(id: string): AnyKind | undefined {
  if (id.startsWith("actor:")) return "actor";
  return kindOf(id);
}

export function buildIndex(view: ViewModel): Index {
  const nodes: XNode[] = view.nodes.map((n) => n as XNode);
  const byId = new Map<string, XNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Actors: one pseudo node per distinct actor name, `uses` edges to its capabilities.
  const actorEdges: XEdge[] = [];
  const actors = new Map<string, XNode>();
  for (const n of nodes) {
    if (n.kind !== "cap") continue;
    for (const a of n.actors ?? []) {
      const id = actorId(a);
      if (!actors.has(id)) {
        actors.set(id, { id, kind: "actor", label: a, cites: [], metrics: { loc: 0, pagerank: 0, churn: 0, tests: 0 }, caps: [], tags: [] });
      }
      actorEdges.push({ from: id, to: n.id, kind: "uses", weight: 1, derived: true });
    }
  }
  for (const a of [...actors.values()].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    nodes.push(a);
    byId.set(a.id, a);
  }

  const children = new Map<string, string[]>();
  for (const n of nodes) if (n.parent && byId.has(n.parent)) push(children, n.parent, n.id);

  const edges: XEdge[] = [...(view.edges as XEdge[]), ...actorEdges];
  const out = new Map<string, XEdge[]>();
  const inc = new Map<string, XEdge[]>();
  for (const e of edges) {
    push(out, e.from, e);
    push(inc, e.to, e);
  }

  const capMembers = new Map<string, string[]>();
  for (const n of nodes) for (const c of n.caps) push(capMembers, c, n.id);

  // Counts of descendants by kind, for the cards' tiny metrics.
  const counts = new Map<string, Counts>();
  const bump = (id: string, kind: AnyKind) => {
    if (!(kind in zero())) return;
    let c = counts.get(id);
    if (!c) counts.set(id, (c = zero()));
    c[kind as keyof Counts]++;
  };
  for (const n of nodes) {
    let p = n.parent ? byId.get(n.parent) : undefined;
    let guard = 0;
    while (p && guard++ < 16) {
      bump(p.id, n.kind);
      p = p.parent ? byId.get(p.parent) : undefined;
    }
    for (const c of n.caps) bump(c, n.kind);
  }

  // Capability colours: by PageRank (the app's centre gets the first hue), ties by id.
  const caps = nodes
    .filter((n) => n.kind === "cap" && n.id !== FOUNDATIONS_CAP)
    .sort((a, b) => b.metrics.pagerank - a.metrics.pagerank || (a.id < b.id ? -1 : 1));
  const capSlot = new Map<string, number>();
  caps.forEach((c, i) => {
    capSlot.set(c.id, i % PALETTE_SIZE);
  });
  capSlot.set(FOUNDATIONS_CAP, -1);

  // Module directories: the longest directory every file of the module sits under.
  const dirs = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind !== "mod") continue;
    let common: string[] | undefined;
    for (const c of children.get(n.id) ?? []) {
      const p = fileOfId(c);
      if (!p) continue;
      const segs = p.split("/").slice(0, -1);
      if (!common) common = segs;
      else {
        let i = 0;
        while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
        common.length = i;
      }
    }
    if (common) dirs.set(n.id, common.join("/"));
  }

  return {
    view,
    nodes,
    byId,
    children,
    out,
    in: inc,
    edges,
    capMembers,
    counts,
    capSlot,
    staleLenses: new Set(view.stale?.lenses ?? []),
    staleFlows: new Set(view.stale?.flows ?? []),
    dirs,
    hasBusiness: nodes.some((n) => n.kind === "cap" && n.id !== FOUNDATIONS_CAP),
  };
}

/**
 * Where a node sits in the repository tree, for grouping by folder: a module
 * at its directory, a file at its path, a symbol / route / screen / job at its
 * file. Undefined for nodes that live nowhere in particular (capabilities,
 * systems, actors) and for anything without a known path.
 */
export function treePath(ix: Index, n: XNode): string | undefined {
  if (n.kind === "mod") return ix.dirs.get(n.id);
  if (n.kind === "file") return fileOfId(n.id);
  if (n.kind === "sym" || n.kind === "route" || n.kind === "screen" || n.kind === "job") return pathOf(n);
  return undefined;
}

/** Ancestors of a node, nearest first. */
export function ancestors(ix: Index, id: string): XNode[] {
  const out: XNode[] = [];
  let cur = ix.byId.get(id);
  let guard = 0;
  while (cur?.parent && guard++ < 16) {
    const p = ix.byId.get(cur.parent);
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}

/** The nearest ancestor (or the node itself) of one kind. */
export function ancestorOfKind(ix: Index, id: string, kind: AnyKind): XNode | undefined {
  const self = ix.byId.get(id);
  if (self?.kind === kind) return self;
  return ancestors(ix, id).find((a) => a.kind === kind);
}

/** The repo-relative path a node lives at, if any (files, symbols, detected nodes). */
export function pathOf(n: XNode): string | undefined {
  const fromId = fileOfId(n.id);
  if (fromId) return fromId;
  if (n.at) return n.at.replace(/:\d+(?:-\d+)?$/, "");
  return undefined;
}

/** `path:line` where a node is defined, if known. */
export function locationOf(n: XNode): { path: string; line: number } | undefined {
  if (n.at) {
    const m = /^(.*):(\d+)(?:-\d+)?$/.exec(n.at);
    if (m) return { path: m[1] as string, line: Number(m[2]) };
  }
  const p = fileOfId(n.id);
  return p ? { path: p, line: 1 } : undefined;
}
