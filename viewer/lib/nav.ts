// Moving around the map: drilling into a node, the breadcrumb that climbs
// back, and where to reveal a node found by search, a flow step or a tour stop.
// Pure functions of the index and the map state.

import { ancestorOfKind, anyKindOf, type Index } from "./data.js";
import { buildScene, FREE_KINDS, groupSteps, type Level, levelsFor, locate, type MapState, type ViewerAudience } from "./levels.js";

/** The map state that shows a node's children, or undefined for a leaf. */
export function drillTarget(ix: Index, id: string): MapState | undefined {
  const n = ix.byId.get(id);
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
  /** Node id, `dir:<group>` for a folder step, or undefined for the level root. */
  id?: string;
  /** Level name for the root crumb (translated by the caller), the node or folder label otherwise. */
  label: string;
  level?: Level;
  /** A part of an over-full folder (0-based; labelled by the caller). */
  part?: number;
  state: MapState;
}

/** The trail from the level root to the focused node, then down the folders of a grouped view. */
export function breadcrumb(ix: Index, s: MapState): Crumb[] {
  const crumbs = focusCrumbs(ix, s);
  if (!s.group) return crumbs;
  const at: MapState = { level: s.level, ...(s.focus ? { focus: s.focus } : {}) };
  // The focus crumb now leads back to the whole focus.
  const last = crumbs[crumbs.length - 1]!;
  last.state = at;
  for (const step of groupSteps(ix, s)) {
    crumbs.push({ id: `dir:${step.group}`, label: step.label, ...(step.part !== undefined ? { part: step.part } : {}), state: { ...at, group: step.group } });
  }
  return crumbs;
}

function focusCrumbs(ix: Index, s: MapState): Crumb[] {
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

const FREE = new Set<string>(FREE_KINDS);

/**
 * Where to show a node so it is drawn as itself: its level, focused on its
 * parent when that keeps the graph small, inside the folder that holds it in
 * a grouped view, and pinned out of its aggregate chip (entities, externals).
 */
export function revealTarget(ix: Index, id: string): MapState {
  let target = levelTarget(ix, id);
  for (let guard = 0; guard < 16; guard++) {
    const at = locate(ix, buildScene(ix, target, "developer"), id);
    if (at === id) break;
    if (FREE.has(anyKindOf(id) ?? "")) {
      target = pin(target, id);
      break;
    }
    if (!at?.startsWith("dir:") || target.group === at.slice(4)) break;
    target = { ...target, group: at.slice(4) };
  }
  return target;
}

/** A map state that draws a free node (entity, external, infrastructure) on its own. */
export function pin(s: MapState, id: string): MapState {
  const open = new Set(s.open ?? []);
  open.add(id);
  return { ...s, open: [...open].sort() };
}

function levelTarget(ix: Index, id: string): MapState {
  const n = ix.byId.get(id);
  const home: Level = ix.hasBusiness ? "biz" : "sys";
  if (!n) return { level: home };
  switch (n.kind) {
    case "cap":
    case "actor":
      return { level: "biz" };
    case "entity":
    case "ext":
    case "infra":
      return { level: home };
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

/** The level the map opens on: Business when the agent wrote a business map, Systems otherwise. */
export function homeLevel(ix: Index): Level {
  return ix.hasBusiness ? "biz" : "sys";
}

/** The viewer's audience for the model's `app.audience`. */
export function defaultAudience(modelAudience: string | undefined): ViewerAudience {
  return modelAudience === "developers" ? "developer" : "business";
}
