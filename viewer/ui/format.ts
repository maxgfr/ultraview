// Small display helpers shared by the map cards, the side panel and the lists.

import type { AnyKind, Index } from "../lib/data.js";
import { fitParts as fitLine } from "../lib/labels.js";

export { cardAria, cardTitle, describeNode, groupParts, kindName, sceneLabel, subline, sublineParts } from "../lib/cards.js";

export const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Width of a string in the UI font, measured once and cached. */
export function textWidth(text: string, size: number, weight = 400): number {
  const key = `${size}|${weight}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  let w: number;
  if (ctx) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    w = ctx.measureText(text).width;
  } else w = text.length * size * 0.56;
  if (widths.size > 20000) widths.clear();
  widths.set(key, w);
  return w;
}

/** A drawn line of a card label: as is, squeezed to `fit` pixels, or cut. */
export interface DrawnLine {
  text: string;
  /** Draw it this many pixels wide (SVG textLength): the face is a little wider than the estimate. */
  fit?: number;
}

/** Past this much too wide, a line is cut rather than squeezed. */
const SQUEEZE_MAX = 1.15;

/**
 * A line laid out with the deterministic estimate (lib/wrap.ts), checked
 * against the face the browser actually draws: a face a little wider is
 * squeezed into the room, a much wider one cut. The card's size never moves.
 */
export function drawnLine(line: string, max: number, size: number, weight = 600): DrawnLine {
  const w = textWidth(line, size, weight);
  if (w <= max) return { text: line };
  if (w <= max * SQUEEZE_MAX) return { text: line, fit: max };
  return { text: ellipsize(line, max, size, weight) };
}

/** The text cut with an ellipsis so it fits `max` pixels. */
export function ellipsize(text: string, max: number, size: number, weight = 400): string {
  if (textWidth(text, size, weight) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(`${text.slice(0, mid)}…`, size, weight) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, Math.max(1, lo)).trimEnd()}…`;
}

/** Icon name for a node kind. */
export function kindIcon(kind: AnyKind | "cluster"): string {
  return kind;
}

/** The capability slot colour class of a node: its first capability's palette slot. */
export function capVar(ix: Index, capId: string): string {
  const slot = ix.capSlot.get(capId);
  return slot === undefined || slot < 0 ? "var(--cap-none)" : `var(--cap-${slot})`;
}

/** The parts joined to fit `max` pixels: the least telling (last) parts drop first, the first one is cut only when alone. */
export function fitParts(parts: readonly string[], max: number, size: number, weight = 400): string {
  return fitLine(
    parts,
    max,
    (x) => textWidth(x, size, weight),
    (x) => ellipsize(x, max, size, weight),
  );
}
