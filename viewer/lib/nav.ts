// Moving around the map: drilling into a node, the breadcrumb that climbs
// back, and where to reveal a node found by search, a flow step or a tour stop.
// Pure functions of the index and the map state.

import { ancestorOfKind, type Index } from "./data.js";
import { type Level, levelsFor, type MapState, type ViewerAudience } from "./levels.js";

/** The map state that shows a node's children, or undefined for a leaf. */
export function drillTarget(ix: Index, id: string): MapState | undefined {
  const realId = id.startsWith("cluster:") ? id.slice("cluster:".length) : id;
  const n = ix.byId.get(realId);
  if (!n) return undefined;
  switch (n.kind) {
    case "cap":
    case "sys":
      return { level: "mod", focus: n.id };
    case "mod":
      return { level: "file", focus: n.id };
    case "file":
      return { level: "sym", focus: n.id };
    default:
      return undefined;
  }
}

export interface Crumb {
  /** Node id, or undefined for the level root. */
  id?: string;
  /** Level name for the root crumb (translated by the caller), the node label otherwise. */
  label: string;
  level?: Level;
  state: MapState;
}

/** The trail from the level root to the focused node. */
export function breadcrumb(ix: Index, s: MapState): Crumb[] {
  const focus = s.focus ? ix.byId.get(s.focus) : undefined;
  if (!focus) return [{ label: s.level, level: s.level, state: { level: s.level } }];
  if (focus.kind === "cap") {
    return [
      { label: "biz", level: "biz", state: { level: "biz" } },
      { id: focus.id, label: focus.label, state: drillTarget(ix, focus.id) ?? s },
    ];
  }
  const chain: string[] = [];
  for (const kind of ["sys", "mod", "file"] as const) {
    const a = ancestorOfKind(ix, focus.id, kind);
    if (a) chain.push(a.id);
  }
  const crumbs: Crumb[] = [{ label: "sys", level: "sys", state: { level: "sys" } }];
  for (const id of chain) {
    const n = ix.byId.get(id)!;
    crumbs.push({ id, label: n.label, state: drillTarget(ix, id) ?? { level: "sys" } });
  }
  return crumbs;
}

/** Where to show a node so it is drawn: its level, focused on its parent when that keeps the graph small. */
export function revealTarget(ix: Index, id: string): MapState {
  const n = ix.byId.get(id);
  if (!n) return { level: "biz" };
  switch (n.kind) {
    case "cap":
    case "actor":
    case "entity":
    case "ext":
    case "infra":
      return { level: "biz" };
    case "sys":
      return { level: "sys" };
    case "mod": {
      const sys = ancestorOfKind(ix, id, "sys");
      return sys ? { level: "mod", focus: sys.id } : { level: "mod" };
    }
    case "file": {
      const mod = ancestorOfKind(ix, id, "mod");
      return mod ? { level: "file", focus: mod.id } : { level: "file" };
    }
    default: {
      const file = ancestorOfKind(ix, id, "file");
      const mod = file ? ancestorOfKind(ix, file.id, "mod") : undefined;
      return { level: "file", ...(mod ? { focus: mod.id } : {}), ...(file ? { expanded: [file.id] } : {}) };
    }
  }
}

/** Whether the audience can open a level; Business keeps files and symbols out of the map. */
export function levelAllowed(level: Level, audience: ViewerAudience): boolean {
  return levelsFor(audience).includes(level);
}

/** The viewer's audience for the model's `app.audience`. */
export function defaultAudience(modelAudience: string | undefined): ViewerAudience {
  return modelAudience === "developers" ? "developer" : "business";
}
