// Telling apart things that share a name: "Admin" and "Admin" side by side
// become "Admin · app/admin" and "Admin · modules/admin". Each one gets the
// shortest tail of its folder that no other same-named one shares. Pure.

import { type Index, treePath } from "./data.js";

export interface Labelled {
  id: string;
  label: string;
  /** The folder it lives in, as path segments (a module's directory, a file's directory). */
  dir?: readonly string[];
}

const tail = (dir: readonly string[], k: number) => dir.slice(Math.max(0, dir.length - k)).join("/");

/** Display labels for items whose label another item repeats; items with a unique label are left out. */
export function disambiguate(items: readonly Labelled[]): Map<string, string> {
  const byLabel = new Map<string, Labelled[]>();
  for (const it of items) {
    const list = byLabel.get(it.label);
    if (list) list.push(it);
    else byLabel.set(it.label, [it]);
  }
  const out = new Map<string, string>();
  for (const [label, list] of byLabel) {
    if (list.length < 2) continue;
    for (const it of list) {
      const dir = it.dir ?? [];
      let hint: string | undefined;
      for (let k = 1; k <= Math.max(1, dir.length); k++) {
        const mine = tail(dir, k);
        if (list.every((o) => o === it || tail(o.dir ?? [], k) !== mine)) {
          hint = mine;
          break;
        }
      }
      // An empty tail is the repository root.
      out.set(it.id, `${label} · ${hint === undefined ? (it.dir ? dir.join("/") || "/" : it.id) : hint || "/"}`);
    }
  }
  return out;
}

/** The folder segments of a path: a directory itself, or a file's directory. */
export function dirSegments(path: string | undefined, isDir: boolean): string[] | undefined {
  if (path === undefined) return undefined;
  const segs = path ? path.split("/") : [];
  return isDir ? segs : segs.slice(0, -1);
}

/** Display labels of view-model nodes listed together (search results, side-panel lists): same kind, same name, told apart. */
export function nodeLabels(ix: Index, ids: readonly string[]): Map<string, string> {
  const byKind = new Map<string, Labelled[]>();
  for (const id of ids) {
    const n = ix.byId.get(id);
    if (!n) continue;
    const dir = dirSegments(treePath(ix, n), n.kind !== "file");
    const list = byKind.get(n.kind) ?? [];
    list.push(dir ? { id, label: n.label, dir } : { id, label: n.label });
    byKind.set(n.kind, list);
  }
  const out = new Map<string, string>();
  for (const list of byKind.values()) for (const [id, l] of disambiguate(list)) out.set(id, l);
  return out;
}

/**
 * A card's short line within `max` pixels: the least telling (last) parts
 * drop first; the first part is cut (by `cut`) only when it is alone and
 * still too wide. `width` measures a string.
 */
export function fitParts(parts: readonly string[], max: number, width: (s: string) => number, cut: (s: string) => string): string {
  const list = [...parts];
  while (list.length > 1 && width(list.join(" · ")) > max) list.pop();
  const line = list.join(" · ");
  return width(line) > max ? cut(line) : line;
}
