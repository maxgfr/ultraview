// Deep links (docs/design.md §8): the URL hash names what is on screen, so a
// link an agent prints (`#lens=how-refunds-work`) opens exactly that.
//
//   #view=map&level=sys&focus=sys:api&node=mod:src
//   #level=mod&focus=sys:app&group=src/app   (a folder of a grouped view; `src/app~1` is its 2nd part)
//   #view=data&node=entity:Order
//   #lens=<id>            (view = lenses)
//   #flow=<id>&step=2     (view = flows; steps count from 1)
//   #change=<id>          (view = changes)
//
// Values keep `:` and `/` readable; everything else is percent-encoded.

import { LEVELS, type Level } from "./levels.js";

export const VIEWS = ["map", "data", "flows", "lenses", "changes", "insights"] as const;
export type ViewName = (typeof VIEWS)[number];

export interface Route {
  view: ViewName;
  level?: Level;
  focus?: string;
  /** Folder of a grouped map view (lib/groups.ts). */
  group?: string;
  /** Selected node. */
  node?: string;
  lens?: string;
  flow?: string;
  /** 1-based flow step. */
  step?: number;
  change?: string;
}

function enc(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
}

function dec(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, "%20"));
  } catch {
    return v;
  }
}

/** The view a route implies when `view` is not spelled out. */
function impliedView(r: Partial<Route>): ViewName {
  if (r.lens) return "lenses";
  if (r.flow) return "flows";
  if (r.change) return "changes";
  return "map";
}

export function parseHash(hash: string): Route {
  const body = hash.replace(/^#/, "");
  const raw: Record<string, string> = {};
  for (const part of body.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? "" : part.slice(eq + 1);
    if (k && !(k in raw)) raw[k] = dec(v);
  }
  const r: Partial<Route> = {};
  if (raw.lens) r.lens = raw.lens;
  if (raw.flow) r.flow = raw.flow;
  if (raw.change) r.change = raw.change;
  if (raw.node) r.node = raw.node;
  if (raw.focus) r.focus = raw.focus;
  if (raw.group) r.group = raw.group;
  if (raw.level && (LEVELS as readonly string[]).includes(raw.level)) r.level = raw.level as Level;
  if (raw.step !== undefined && /^\d+$/.test(raw.step) && Number(raw.step) >= 1) r.step = Number(raw.step);
  const view = raw.view && (VIEWS as readonly string[]).includes(raw.view) ? (raw.view as ViewName) : impliedView(r);
  return { view, ...r };
}

export function formatHash(r: Route): string {
  const parts: string[] = [];
  if (r.view !== impliedView(r)) parts.push(`view=${r.view}`);
  if (r.lens) parts.push(`lens=${enc(r.lens)}`);
  if (r.flow) parts.push(`flow=${enc(r.flow)}`);
  if (r.flow && r.step !== undefined) parts.push(`step=${r.step}`);
  if (r.change) parts.push(`change=${enc(r.change)}`);
  if (r.level) parts.push(`level=${r.level}`);
  if (r.focus) parts.push(`focus=${enc(r.focus)}`);
  if (r.group) parts.push(`group=${enc(r.group)}`);
  if (r.node) parts.push(`node=${enc(r.node)}`);
  return parts.length ? `#${parts.join("&")}` : "";
}
