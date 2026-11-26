// Hub summaries (docs/design.md §8): on a big repository nearly every page
// module imports the same few parts (`src/modules`, `src/server`), and a line
// from each of them to each hub turns any view into a fan. In a drawn view, a
// node that receives lines from more than HUB_SHARE of the visible cards (and
// from at least HUB_MIN_SOURCES of them) is a hub: its incoming lines are left
// out of the layout and the hub carries a "used by N" badge instead. Hovering
// or selecting the hub, or one of its sources, draws those lines again as
// straight connectors between the cards. Pure: no DOM.

import type { Box, Pt } from "./elk.js";
import type { SceneEdge, SceneNode } from "./levels.js";

/** Share of the visible cards a node must receive lines from to be summarized. */
export const HUB_SHARE = 0.35;
/** Distinct sources a hub needs at least, whatever the view's size. */
export const HUB_MIN_SOURCES = 6;

export interface HubSplit {
  /** Hub scene id → how many distinct cards use it (the badge's N). */
  hubs: Map<string, number>;
  /** Lines the layout draws. */
  kept: SceneEdge[];
  /** Lines into a hub: drawn only when the hub or their source is hovered or selected. */
  hidden: SceneEdge[];
}

/** Whether `sources` users out of `cards` visible cards make a node a hub. */
export function isHub(sources: number, cards: number): boolean {
  return sources >= HUB_MIN_SOURCES && sources > HUB_SHARE * cards;
}

/**
 * Split a view's lines into the ones drawn and the ones summarized by a hub
 * badge. Flow steps are never summarized. Input order is kept in both lists.
 */
export function summarizeHubs(nodes: readonly SceneNode[], edges: readonly SceneEdge[]): HubSplit {
  const cards = nodes.filter((n) => n.role !== "group").length;
  const sources = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind === "step") continue;
    let s = sources.get(e.to);
    if (!s) sources.set(e.to, (s = new Set()));
    s.add(e.from);
  }
  const hubs = new Map<string, number>();
  for (const [id, s] of [...sources.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) if (isHub(s.size, cards)) hubs.set(id, s.size);
  if (!hubs.size) return { hubs, kept: [...edges], hidden: [] };
  const kept: SceneEdge[] = [];
  const hidden: SceneEdge[] = [];
  for (const e of edges) (e.kind !== "step" && hubs.has(e.to) ? hidden : kept).push(e);
  return { hubs, kept, hidden };
}

/** The summarized lines to draw while these scene ids are hovered or selected: every line touching one of them. */
export function revealedHubEdges(hidden: readonly SceneEdge[], active: readonly (string | undefined)[]): SceneEdge[] {
  const on = new Set(active.filter((x): x is string => !!x));
  if (!on.size || !hidden.length) return [];
  return hidden.filter((e) => on.has(e.from) || on.has(e.to));
}

const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where the line from a box's centre towards `toward` leaves the box. */
export function borderPoint(b: Box, toward: Pt): Pt {
  const c = centre(b);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const sx = dx ? b.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const sy = dy ? b.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const s = Math.min(sx, sy, 1);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** A straight connector between two placed boxes, border to border (a revealed hub line has no routed path). */
export function connector(from: Box, to: Box): Pt[] {
  return [borderPoint(from, centre(to)), borderPoint(to, centre(from))];
}
