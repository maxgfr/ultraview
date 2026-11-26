// Component packing. ELK's layered algorithm lays each connected component out
// well but stacks the components in one column, so a schema of mostly unlinked
// entities becomes a tall strip that fit-to-screen shrinks to nothing. Here the
// components of a laid-out scene are cut apart and packed in shelves (rows) of
// the width whose result comes closest to a target aspect ratio: the
// viewport's. Each component keeps its own layout; a scene of one component is
// returned untouched. Pure: no DOM.

import type { Layout, Pt } from "./elk.js";
import type { Scene } from "./levels.js";

export interface PackItem {
  id: string;
  w: number;
  h: number;
}

export interface Packing {
  /** Top-left corner of each item. */
  pos: Map<string, Pt>;
  width: number;
  height: number;
}

/** Gap between packed components, both ways (ELK's componentComponent spacing). */
export const PACK_GAP = 40;

/** Largest first (area, then height, then width), ties by id: the order shelves are filled in. */
function packOrder(items: readonly PackItem[]): PackItem[] {
  return [...items].sort((a, b) => b.w * b.h - a.w * a.h || b.h - a.h || b.w - a.w || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Next-fit shelves no wider than `limit` (an item wider than it gets a shelf of its own). */
function shelves(items: readonly PackItem[], limit: number, gap: number): Packing {
  const pos = new Map<string, Pt>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > limit) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    pos.set(it.id, { x, y });
    width = Math.max(width, x + it.w);
    rowH = Math.max(rowH, it.h);
    x += it.w + gap;
  }
  return { pos, width, height: items.length ? y + rowH : 0 };
}

/**
 * Pack boxes in shelves, largest first, choosing the shelf width whose
 * bounding box is closest to `aspect` (width / height, compared on a log
 * scale; ties go to the smaller area, then the narrower). Deterministic: the
 * same items in any order give the same positions.
 */
export function packShelves(items: readonly PackItem[], aspect: number, gap: number = PACK_GAP): Packing {
  const order = packOrder(items);
  if (!order.length) return { pos: new Map(), width: 0, height: 0 };
  const target = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.6;
  // Candidate widths: every prefix of the order on one shelf (the widest item at least).
  const widest = Math.max(...order.map((i) => i.w));
  const limits = new Set<number>();
  let run = -gap;
  for (const it of order) {
    run += it.w + gap;
    limits.add(Math.max(widest, run));
  }
  let best: { p: Packing; score: number; area: number } | undefined;
  for (const limit of [...limits].sort((a, b) => a - b)) {
    const p = shelves(order, limit, gap);
    const score = Math.abs(Math.log(p.width / Math.max(1, p.height) / target));
    const area = p.width * p.height;
    const EPS = 1e-9;
    if (!best || score < best.score - EPS || (Math.abs(score - best.score) <= EPS && area < best.area)) best = { p, score, area };
  }
  return best!.p;
}

/** Connected components of a scene's top-level nodes (a child counts as its outermost group), in scene order. */
export function sceneComponents(scene: Scene): string[][] {
  const parentOf = new Map(scene.nodes.map((n) => [n.id, n.parent]));
  const rootOf = (id: string): string => {
    let cur = id;
    for (let guard = 0; guard < 32; guard++) {
      const p = parentOf.get(cur);
      if (!p || !parentOf.has(p)) break;
      cur = p;
    }
    return cur;
  };
  const up = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (up.get(r) !== r) r = up.get(r)!;
    // Path compression.
    let c = a;
    while (c !== r) {
      const next = up.get(c)!;
      up.set(c, r);
      c = next;
    }
    return r;
  };
  const tops = scene.nodes.filter((n) => !n.parent || !parentOf.has(n.parent)).map((n) => n.id);
  for (const id of tops) up.set(id, id);
  for (const e of scene.edges) {
    if (!parentOf.has(e.from) || !parentOf.has(e.to)) continue;
    const a = find(rootOf(e.from));
    const b = find(rootOf(e.to));
    if (a !== b) up.set(b, a);
  }
  const groups = new Map<string, string[]>();
  for (const id of tops) {
    const r = find(id);
    const list = groups.get(r);
    if (list) list.push(id);
    else groups.set(r, [id]);
  }
  return [...groups.values()];
}

/**
 * Re-arrange a laid-out scene's connected components in shelves targeting
 * `aspect` (the viewport's width / height). Nodes, their descendants and the
 * edges of each component move together; the outer padding of the layout is
 * kept. A layout with fewer than two components comes back as is.
 */
export function packLayout(layout: Layout, scene: Scene, aspect: number, gap: number = PACK_GAP): Layout {
  const comps = sceneComponents(scene);
  if (comps.length < 2) return layout;
  // Every node, under the component of its outermost group.
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => {
    for (const id of c) compOf.set(id, i);
  });
  const parentOf = new Map(scene.nodes.map((n) => [n.id, n.parent]));
  const compOfNode = (id: string): number | undefined => {
    let cur: string | undefined = id;
    for (let guard = 0; cur !== undefined && guard < 32; guard++) {
      const c = compOf.get(cur);
      if (c !== undefined) return c;
      cur = parentOf.get(cur);
    }
    return undefined;
  };
  const edgeComp = new Map<string, number>();
  for (const e of scene.edges) {
    const c = compOfNode(e.from);
    if (c !== undefined) edgeComp.set(e.id, c);
  }
  // Bounding box of each component (its nodes and its routed edges).
  const bounds = comps.map(() => ({ x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: Number.NEGATIVE_INFINITY, y1: Number.NEGATIVE_INFINITY }));
  const grow = (c: number, x0: number, y0: number, x1: number, y1: number) => {
    const b = bounds[c]!;
    b.x0 = Math.min(b.x0, x0);
    b.y0 = Math.min(b.y0, y0);
    b.x1 = Math.max(b.x1, x1);
    b.y1 = Math.max(b.y1, y1);
  };
  for (const [id, box] of layout.nodes) {
    const c = compOfNode(id);
    if (c !== undefined) grow(c, box.x, box.y, box.x + box.w, box.y + box.h);
  }
  for (const [id, pts] of layout.edges) {
    const c = edgeComp.get(id);
    if (c !== undefined) for (const p of pts) grow(c, p.x, p.y, p.x, p.y);
  }
  const placed = comps.map((_, i) => i).filter((i) => Number.isFinite(bounds[i]!.x0));
  if (placed.length < 2) return layout;
  // A component is named by its first node in scene order: stable across runs.
  const items = placed.map((i) => ({ id: comps[i]![0]!, w: bounds[i]!.x1 - bounds[i]!.x0, h: bounds[i]!.y1 - bounds[i]!.y0 }));
  const pad = Math.max(0, Math.min(...placed.map((i) => bounds[i]!.x0)), Math.min(...placed.map((i) => bounds[i]!.y0)));
  const packing = packShelves(items, aspect, gap);
  const shift = new Map<number, Pt>();
  for (const i of placed) {
    const at = packing.pos.get(comps[i]![0]!)!;
    shift.set(i, { x: pad + at.x - bounds[i]!.x0, y: pad + at.y - bounds[i]!.y0 });
  }
  const nodes = new Map(layout.nodes);
  for (const [id, box] of layout.nodes) {
    const c = compOfNode(id);
    const d = c === undefined ? undefined : shift.get(c);
    if (d) nodes.set(id, { ...box, x: box.x + d.x, y: box.y + d.y });
  }
  const edges = new Map(layout.edges);
  for (const [id, pts] of layout.edges) {
    const c = edgeComp.get(id);
    const d = c === undefined ? undefined : shift.get(c);
    if (d)
      edges.set(
        id,
        pts.map((p) => ({ x: p.x + d.x, y: p.y + d.y })),
      );
  }
  return { ...layout, nodes, edges, width: packing.width + 2 * pad, height: packing.height + 2 * pad };
}
