// Scene ⇄ ELK JSON. The scene becomes a layered ELK graph (groups as compound
// nodes, every edge on the root, coordinates reported relative to the root);
// the result becomes a Layout the renderer reads. A plain grid layout stands
// in when ELK cannot run, so the map always draws. Pure: no DOM.

import type { Scene } from "./levels.js";

export interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
}

export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections?: { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }[];
}

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  key: string;
  nodes: Map<string, Box>;
  edges: Map<string, Pt[]>;
  width: number;
  height: number;
  /** Which engine placed it. */
  engine: "elk" | "grid";
}

export type Direction = "RIGHT" | "DOWN";

const GROUP_PAD = "[top=40,left=16,bottom=16,right=16]";

export function toElkGraph(scene: Scene, direction: Direction = "RIGHT", layerGap = 64): ElkNode {
  const root: ElkNode = {
    id: "__root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerGap),
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.spacing.nodeNode": "20",
      "elk.spacing.edgeNode": "16",
      "elk.spacing.edgeEdge": "10",
      "elk.spacing.componentComponent": "40",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.compaction.connectedComponents": "true",
      "elk.aspectRatio": "1.6",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
    },
    children: [],
    edges: [],
  };
  const byId = new Map<string, ElkNode>();
  for (const n of scene.nodes) {
    const e: ElkNode =
      n.role === "group"
        ? { id: n.id, children: [], layoutOptions: { "elk.padding": GROUP_PAD, "elk.direction": direction } }
        : { id: n.id, width: n.w, height: n.h };
    byId.set(n.id, e);
  }
  for (const n of scene.nodes) {
    const e = byId.get(n.id)!;
    const parent = n.parent ? byId.get(n.parent) : undefined;
    (parent?.children ?? root.children!).push(e);
  }
  // An empty group would collapse to nothing: give it a card's size.
  for (const n of scene.nodes) {
    const e = byId.get(n.id)!;
    if (n.role === "group" && !e.children?.length) {
      delete e.children;
      e.width = 216;
      e.height = 64;
    }
  }
  for (const e of scene.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    root.edges!.push({ id: e.id, sources: [e.from], targets: [e.to] });
  }
  return root;
}

export function fromElk(key: string, result: ElkNode): Layout {
  const nodes = new Map<string, Box>();
  const edges = new Map<string, Pt[]>();
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
      walk(c);
    }
    for (const e of n.edges ?? []) {
      const pts: Pt[] = [];
      for (const s of e.sections ?? []) {
        if (!pts.length) pts.push(s.startPoint);
        for (const b of s.bendPoints ?? []) pts.push(b);
        pts.push(s.endPoint);
      }
      if (pts.length >= 2) edges.set(e.id, pts);
    }
  };
  walk(result);
  return { key, nodes, edges, width: result.width ?? 0, height: result.height ?? 0, engine: "elk" };
}

/** Where the line from the centre of `a` towards the centre of `b` leaves `a`. */
function border(a: Box, b: Box): Pt {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const dx = b.x + b.w / 2 - cx;
  const dy = b.y + b.h / 2 - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const t = Math.min(dx ? a.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY, dy ? a.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** A plain grid (groups as boxes of grids), straight edges between centres: the layout when ELK cannot run. */
export function gridLayout(scene: Scene): Layout {
  const GAP = 24;
  const nodes = new Map<string, Box>();
  const kids = new Map<string, string[]>();
  const top: string[] = [];
  for (const n of scene.nodes) {
    if (n.parent) {
      const list = kids.get(n.parent) ?? [];
      list.push(n.id);
      kids.set(n.parent, list);
    } else top.push(n.id);
  }
  const size = new Map(scene.nodes.map((n) => [n.id, { w: n.w, h: n.h }]));
  // Size bottom-up: a group is a grid of its children plus padding.
  const measure = (id: string): { w: number; h: number } => {
    const children = kids.get(id);
    if (!children?.length) return size.get(id) && size.get(id)!.w ? size.get(id)! : { w: 216, h: 64 };
    const dims = children.map(measure);
    const cols = Math.max(1, Math.ceil(Math.sqrt(children.length)));
    const cw = Math.max(...dims.map((d) => d.w));
    const ch = Math.max(...dims.map((d) => d.h));
    const rows = Math.ceil(children.length / cols);
    const s = { w: cols * cw + (cols - 1) * GAP + 32, h: rows * ch + (rows - 1) * GAP + 56 };
    size.set(id, s);
    return s;
  };
  const place = (ids: string[], x0: number, y0: number, cols: number) => {
    const dims = ids.map(measure);
    const cw = Math.max(0, ...dims.map((d) => d.w));
    const ch = Math.max(0, ...dims.map((d) => d.h));
    ids.forEach((id, i) => {
      const d = dims[i]!;
      const x = x0 + (i % cols) * (cw + GAP);
      const y = y0 + Math.floor(i / cols) * (ch + GAP);
      nodes.set(id, { x, y, w: d.w, h: d.h });
      const children = kids.get(id);
      if (children?.length) place(children, x + 16, y + 40, Math.max(1, Math.ceil(Math.sqrt(children.length))));
    });
    return { w: cols * (cw + GAP), h: Math.ceil(ids.length / cols) * (ch + GAP) };
  };
  const cols = Math.max(1, Math.ceil(Math.sqrt(top.length * 1.6)));
  const total = place(top, 24, 24, cols);
  const edges = new Map<string, Pt[]>();
  for (const e of scene.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (a && b) edges.set(e.id, [border(a, b), border(b, a)]);
  }
  return { key: scene.key, nodes, edges, width: total.w + 48, height: total.h + 48, engine: "grid" };
}
