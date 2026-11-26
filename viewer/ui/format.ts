// Small display helpers shared by the map cards, the side panel and the lists.

import { type AnyKind, type Index, pathOf, type XNode } from "../lib/data.js";
import type { ViewerAudience } from "../lib/levels.js";
import { num, t } from "../lib/i18n.js";

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

export function kindName(kind: AnyKind | "cluster"): string {
  return t(`kind.${kind}`);
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

/** The short line under a card's label: what it holds, or where it lives. */
export function subline(ix: Index, n: XNode, audience: ViewerAudience): string {
  const c = ix.counts.get(n.id);
  const parts: string[] = [];
  const add = (count: number | undefined, key: string) => {
    if (count) parts.push(t(key, { count, n: num(count) }));
  };
  switch (n.kind) {
    case "cap":
      add(c?.mod, "count.modules");
      add(c?.route, "count.routes");
      add(c?.entity, "count.entities");
      if (!parts.length) add(c?.file, "count.files");
      break;
    case "actor":
      parts.push(t("kind.actor"));
      break;
    case "sys":
      if (audience === "business" && n.caps.length) return capNames(ix, n.caps);
      add(c?.mod, "count.modules");
      add(c?.file, "count.files");
      add(c?.route, "count.routes");
      break;
    case "mod":
      if (audience === "business" && n.caps.length) return capNames(ix, n.caps);
      add(c?.file, "count.files");
      add(c?.route, "count.routes");
      add(c?.entity, "count.entities");
      break;
    case "file": {
      if (audience === "developer") {
        const p = pathOf(n) ?? "";
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        if (dir) parts.push(dir);
      }
      add(c?.route, "count.routes");
      add(c?.sym, "count.symbols");
      break;
    }
    case "entity":
      add(n.fields?.length, "count.fields");
      if (!parts.length) parts.push(kindName(n.kind));
      break;
    default: {
      parts.push(kindName(n.kind));
      const at = audience === "developer" ? n.at : undefined;
      if (at) parts.push(at.split("/").pop() ?? at);
    }
  }
  return parts.join(" · ");
}

function capNames(ix: Index, caps: readonly string[]): string {
  const names = caps.map((c) => ix.byId.get(c)?.label ?? c);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

/** One-sentence spoken description of a node, for screen readers. */
export function describeNode(ix: Index, n: XNode, audience: ViewerAudience): string {
  const s = subline(ix, n, audience);
  return `${kindName(n.kind)}: ${n.label}${s ? `. ${s}` : ""}`;
}
