// Grouping by folder (docs/design.md §8): a level or focus that would draw
// more than GROUP_LIMIT cards shows folders instead, so every view stays
// readable. Members sit in a tree of their repository paths (a module at its
// directory, a file at its path, a symbol at its file). The view starts from
// the members' common folder with one card per next path segment, then opens
// the biggest folders in place while the view stays within the limit, so a
// shallow tree shows its detail and a deep one stays a handful of folders.
// It opens folders while the view stays within FILL_TARGET cards (fewer
// cards, fewer lines), never past GROUP_LIMIT. A folder that holds more
// direct members than the limit is cut into parts of at most FILL_TARGET.
//
// A view is named by its group: a folder path ("src/app"), or a part of one
// ("src/app~1", 0-based), which deep links carry as `group=`. Pure and
// deterministic: same members, same group, same cards.

/** Cards a view draws at most before it groups by folder: the hard cap. */
export const GROUP_LIMIT = 40;
/** Cards a grouped view aims for: folders open in place while the view stays within it. */
export const FILL_TARGET = 28;

export interface PathMember {
  id: string;
  label: string;
  /** Repository path ("" for the root); undefined when the member lives nowhere in particular. */
  path?: string;
}

export type GroupItem =
  | { type: "member"; id: string }
  | {
      type: "dir";
      /** The group state that opens it (`dir` or `dir~part`). */
      group: string;
      label: string;
      /** Every member it stands for. */
      ids: string[];
      /** A part of an over-full folder, 0-based. */
      part?: number;
    };

export interface Grouping {
  items: GroupItem[];
  /** The folder the view starts from ("" at the repository root). */
  base: string;
  /** Members in the view, before grouping. */
  total: number;
}

interface Trie {
  path: string;
  /** Members sitting exactly here, in input order. */
  here: PathMember[];
  kids: Map<string, Trie>;
  count: number;
}

type Entry = { type: "member"; m: PathMember } | { type: "dir"; node: Trie };

export function parseGroup(group: string): { dir: string; part?: number } {
  const m = /^(.*)~(\d+)$/.exec(group);
  return m ? { dir: m[1] as string, part: Number(m[2]) } : { dir: group };
}

const segsOf = (p: string): string[] => (p ? p.split("/") : []);

function isUnder(path: string, dir: string): boolean {
  return !dir || path === dir || path.startsWith(`${dir}/`);
}

function buildTrie(members: readonly PathMember[]): Trie {
  const root: Trie = { path: "", here: [], kids: new Map(), count: 0 };
  for (const m of members) {
    let node = root;
    node.count++;
    for (const seg of segsOf(m.path ?? "")) {
      let kid = node.kids.get(seg);
      if (!kid) node.kids.set(seg, (kid = { path: node.path ? `${node.path}/${seg}` : seg, here: [], kids: new Map(), count: 0 }));
      node = kid;
      node.count++;
    }
    node.here.push(m);
  }
  return root;
}

/** Skip folders that hold nothing but one sub-folder. */
function compress(node: Trie): Trie {
  let cur = node;
  while (!cur.here.length && cur.kids.size === 1) cur = cur.kids.values().next().value as Trie;
  return cur;
}

function firstMember(node: Trie): PathMember {
  let cur = node;
  while (!cur.here.length) cur = [...cur.kids.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))[0]![1];
  return cur.here[0]!;
}

function collect(node: Trie, out: string[] = []): string[] {
  for (const m of node.here) out.push(m.id);
  for (const k of [...node.kids.keys()].sort()) collect(node.kids.get(k)!, out);
  return out;
}

/** What a folder shows when opened: the members sitting in it, then one entry per sub-folder. */
function open(node: Trie, cache: Map<Trie, Entry[]>): Entry[] {
  const hit = cache.get(node);
  if (hit) return hit;
  const out: Entry[] = node.here.map((m) => ({ type: "member", m }));
  for (const k of [...node.kids.keys()].sort()) {
    const c = compress(node.kids.get(k)!);
    out.push(c.count === 1 ? { type: "member", m: firstMember(c) } : { type: "dir", node: c });
  }
  cache.set(node, out);
  return out;
}

const sortKey = (e: Entry): string => (e.type === "member" ? `${e.m.path ?? ""}\u0000${e.m.label}\u0000${e.m.id}` : `${e.node.path}\u0000`);

/** Cut entries into the fewest parts of at most `limit`, balanced. */
function parts(entries: Entry[], limit: number): Entry[][] {
  const sorted = [...entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const n = Math.max(1, Math.ceil(sorted.length / Math.max(1, limit)));
  const size = Math.ceil(sorted.length / n);
  const out: Entry[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

const rel = (path: string, base: string): string => (base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path === base ? "" : path);

function entryLabel(e: Entry, base: string): string {
  if (e.type === "member") return e.m.label;
  return rel(e.node.path, base) || e.node.path.split("/").pop() || "/";
}

/**
 * Group a level's members for one view. Members without a path always show
 * as themselves (outside any group view); a `group` keeps only the members
 * under its folder. A view of at most `limit` members shows them all
 * (`limit` Infinity turns grouping off: show all); a bigger one opens folders
 * while it stays within `target` cards, and cuts a folder holding more than
 * `limit` direct entries into parts of at most `target`.
 */
export function groupMembers(members: readonly PathMember[], group: string | undefined, limit = GROUP_LIMIT, target = Math.min(limit, FILL_TARGET)): Grouping {
  const fill = Math.max(1, Math.min(limit, target));
  const g = group ? parseGroup(group) : undefined;
  const pathless = g ? [] : members.filter((m) => m.path === undefined);
  const pathed = members.filter((m) => m.path !== undefined && (!g || isUnder(m.path, g.dir)));
  const total = pathless.length + pathed.length;
  const root = buildTrie(pathed);
  let baseNode = root;
  for (const seg of segsOf(g?.dir ?? "")) {
    const next = baseNode.kids.get(seg);
    if (!next) break;
    baseNode = next;
  }
  baseNode = compress(baseNode);
  const base = baseNode.path;
  const asMembers = (list: readonly PathMember[]): GroupItem[] => list.map((m) => ({ type: "member", id: m.id }));
  if (total <= limit && g?.part === undefined) return { items: asMembers([...pathless, ...pathed]), base, total };

  const cache = new Map<Trie, Entry[]>();
  let entries = open(baseNode, cache);
  if (g?.part !== undefined) entries = parts(entries, fill)[g.part] ?? [];
  else if (pathless.length + entries.length > limit) {
    // An over-full folder: one card per part.
    const ps = parts(entries, fill);
    const items: GroupItem[] = ps.map((p, i) => ({
      type: "dir",
      group: `${base}~${i}`,
      label: `${entryLabel(p[0]!, base)} – ${entryLabel(p[p.length - 1]!, base)}`,
      ids: p.flatMap((e) => (e.type === "member" ? [e.m.id] : collect(e.node))),
      part: i,
    }));
    return { items: [...asMembers(pathless), ...items], base, total };
  }

  // Open the biggest folders in place while the view stays within the fill target.
  const budget = fill - pathless.length;
  for (;;) {
    let best = -1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.type !== "dir") continue;
      if (entries.length - 1 + open(e.node, cache).length > budget) continue;
      const b = best === -1 ? undefined : (entries[best] as { node: Trie }).node;
      if (!b || e.node.count > b.count || (e.node.count === b.count && e.node.path < b.path)) best = i;
    }
    if (best === -1) break;
    entries = [...entries.slice(0, best), ...open((entries[best] as { node: Trie }).node, cache), ...entries.slice(best + 1)];
  }
  const items: GroupItem[] = entries.map((e) =>
    e.type === "member" ? { type: "member", id: e.m.id } : { type: "dir", group: e.node.path, label: entryLabel(e, base), ids: collect(e.node) },
  );
  return { items: [...asMembers(pathless), ...items], base, total };
}

/** The folder steps from the members' common folder down to a group, for the breadcrumb. */
export function groupTrail(members: readonly PathMember[], group: string): { group: string; label: string; part?: number }[] {
  const g = parseGroup(group);
  const base = compress(buildTrie(members.filter((m) => m.path !== undefined))).path;
  if (!isUnder(g.dir, base)) return [];
  const out: { group: string; label: string; part?: number }[] = [];
  let path = base;
  for (const seg of segsOf(rel(g.dir, base))) {
    path = path ? `${path}/${seg}` : seg;
    out.push({ group: path, label: seg });
  }
  if (g.part !== undefined) out.push({ group, label: "", part: g.part });
  return out;
}
