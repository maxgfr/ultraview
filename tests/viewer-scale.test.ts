// The viewer on large repositories: grouping by folder, aggregate chips,
// same-name disambiguation, the no-model defaults and deep links to a folder.
// Pure logic (viewer/lib) over synthetic view-models shaped like a real
// monorepo; runs in node.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ViewModel } from "../src/model/types.js";
import { buildIndex, type Index } from "../viewer/lib/data.js";
import { GROUP_LIMIT, groupMembers, groupTrail, type PathMember, parseGroup } from "../viewer/lib/groups.js";
import { disambiguate, fitParts, nodeLabels } from "../viewer/lib/labels.js";
import { buildScene, levelMembers, locate, type MapState, type Scene } from "../viewer/lib/levels.js";
import { breadcrumb, homeLevel, revealTarget } from "../viewer/lib/nav.js";
import { formatHash, parseHash, type Route } from "../viewer/lib/route.js";

const shop = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/shop.view.json"), "utf8")) as ViewModel;
const metrics = { loc: 1, pagerank: 0, churn: 0, tests: 0 };
const node = (id: string, kind: string, label: string, parent?: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  label,
  ...(parent ? { parent } : {}),
  cites: [],
  metrics,
  caps: ["cap:_foundations"],
  tags: [],
  ...extra,
});

/**
 * A monorepo without a model: one system holding one module per directory
 * (a module's slug is its path with `/` → `-`), two files per module,
 * imports from every page module to `src/modules/shared`, and externals and
 * entities reached from some modules.
 */
function monorepo(dirs: string[], opts: { externals?: number; entities?: number; withBusiness?: boolean } = {}): ViewModel {
  const nodes: any[] = [node("cap:_foundations", "cap", "Shared foundations"), node("sys:app", "sys", "app"), node("sys:tools", "sys", "tools")];
  const edges: any[] = [];
  if (opts.withBusiness) nodes.push(node("cap:ordering", "cap", "Ordering"));
  const mods: string[] = [];
  for (const d of dirs) {
    const id = `mod:${d.replace(/\//g, "-")}`;
    mods.push(id);
    const seg = d.split("/").pop()!;
    nodes.push(node(id, "mod", seg.charAt(0).toUpperCase() + seg.slice(1), d.startsWith("tools") ? "sys:tools" : "sys:app"));
    for (const f of ["index.ts", "util.ts"]) nodes.push(node(`file:${d}/${f}`, "file", f, id));
  }
  const shared = mods.find((m) => m.endsWith("src-modules-shared"));
  for (const m of mods) if (shared && m !== shared) edges.push({ from: m, to: shared, kind: "import", weight: 2, derived: true });
  for (let i = 0; i < (opts.externals ?? 0); i++) {
    nodes.push(node(`ext:svc${i}`, "ext", `svc${i}.example`, undefined, { caps: [] }));
    edges.push({ from: mods[i % mods.length], to: `ext:svc${i}`, kind: "http", weight: 1, derived: true });
    edges.push({ from: "sys:app", to: `ext:svc${i}`, kind: "http", weight: 1, derived: true });
  }
  for (let i = 0; i < (opts.entities ?? 0); i++) {
    nodes.push(node(`entity:E${i}`, "entity", `E${i}`, `file:${dirs[0]}/index.ts`, { caps: [], fields: [] }));
    edges.push({ from: mods[(i + 1) % mods.length], to: `entity:E${i}`, kind: "data", weight: 3, derived: true });
    edges.push({ from: "sys:app", to: `entity:E${i}`, kind: "data", weight: 3, derived: true });
  }
  return { ...shop, app: { ...shop.app, summary: undefined } as any, nodes, edges, flows: [], lenses: [], tour: [] };
}

/** 120 page modules under src/app (one level), 60 feature modules under src/modules/<area>/<feature>, a few tools. */
const DIRS = [
  "src",
  "src/app",
  ...Array.from({ length: 120 }, (_, i) => `src/app/page${String(i).padStart(3, "0")}`),
  "src/modules/shared",
  ...Array.from({ length: 60 }, (_, i) => `src/modules/area${i % 6}/feature${i}`),
  "src/app/admin",
  "src/modules/admin",
  "tools/scripts",
  "tools/lint",
];
const ix = buildIndex(monorepo(DIRS, { externals: 9, entities: 28 }));
const cards = (s: Scene) => s.nodes.filter((n) => n.role !== "group");

/** Every view reachable by opening folders, from a state; checks each one on the way. */
function walk(index: Index, start: MapState, visit: (s: Scene, st: MapState) => void, depth = 0): void {
  const s = buildScene(index, start, "developer");
  visit(s, start);
  if (depth > 8) return;
  for (const n of s.nodes) if (n.role === "cluster" && n.group !== undefined) walk(index, { ...start, group: n.group }, visit, depth + 1);
}

describe("grouping by folder", () => {
  it("keeps every view within the limit and every member reachable exactly once", () => {
    const start: MapState = { level: "mod", focus: "sys:app" };
    const members = new Set(levelMembers(ix, start).map((m) => m.id));
    expect(members.size).toBeGreaterThan(180);
    const seen = new Map<string, number>();
    walk(ix, start, (s) => {
      const memberCards = s.nodes.filter((n) => n.role === "card" || n.role === "cluster");
      expect(memberCards.length).toBeLessThanOrEqual(GROUP_LIMIT);
      for (const n of s.nodes) if (n.role === "card") seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
    });
    // Reached as a card in exactly one leaf view (folders partition their members).
    expect([...members].filter((m) => seen.get(m) !== 1)).toEqual([]);
  });

  it("is deterministic and independent of input order", () => {
    const pm: PathMember[] = DIRS.map((d) => ({ id: `mod:${d}`, label: d.split("/").pop()!, path: d }));
    const a = groupMembers(pm, undefined);
    const b = groupMembers([...pm].reverse(), undefined);
    const norm = (g: typeof a) => g.items.map((i) => (i.type === "member" ? i.id : `${i.group}:${[...i.ids].sort().join(",")}`)).sort();
    expect(norm(b)).toEqual(norm(a));
    expect(JSON.stringify(buildScene(ix, { level: "mod", focus: "sys:app" }, "developer").nodes)).toBe(
      JSON.stringify(buildScene(buildIndex(monorepo(DIRS, { externals: 9, entities: 28 })), { level: "mod", focus: "sys:app" }, "developer").nodes),
    );
  });

  it("starts from the common folder, opens the biggest folders while they fit, skips single-child chains", () => {
    const pm: PathMember[] = [
      { id: "a", label: "a", path: "repo/pkg/src/a" },
      { id: "b", label: "b", path: "repo/pkg/src/b" },
      ...Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, label: `x${i}`, path: `repo/pkg/src/deep/only/x${i}` })),
    ];
    const g = groupMembers(pm, undefined);
    expect(g.base).toBe("repo/pkg/src");
    expect(g.items).toEqual([
      { type: "member", id: "a" },
      { type: "member", id: "b" },
      { type: "dir", group: "repo/pkg/src/deep/only", label: "deep/only", ids: Array.from({ length: 50 }, (_, i) => `x${i}`).sort() },
    ]);
    expect(groupTrail(pm, "repo/pkg/src/deep/only")).toEqual([
      { group: "repo/pkg/src/deep", label: "deep" },
      { group: "repo/pkg/src/deep/only", label: "only" },
    ]);
  });

  it("cuts an over-full folder into balanced parts, each opening to at most the limit", () => {
    const pm: PathMember[] = Array.from({ length: 100 }, (_, i) => ({
      id: `f${i}`,
      label: `f${String(i).padStart(3, "0")}.sql`,
      path: `db/migrations/f${String(i).padStart(3, "0")}.sql`,
    }));
    const g = groupMembers(pm, undefined);
    expect(g.items.map((i) => (i.type === "dir" ? [i.group, i.ids.length, i.label] : i.id))).toEqual([
      ["db/migrations~0", 34, "f000.sql – f033.sql"],
      ["db/migrations~1", 34, "f034.sql – f067.sql"],
      ["db/migrations~2", 32, "f068.sql – f099.sql"],
    ]);
    const part = groupMembers(pm, "db/migrations~1");
    expect(part.items).toHaveLength(34);
    expect(part.items.every((i) => i.type === "member")).toBe(true);
    expect(parseGroup("db/migrations~1")).toEqual({ dir: "db/migrations", part: 1 });
    expect(groupTrail(pm, "db/migrations~1")).toEqual([{ group: "db/migrations~1", label: "", part: 1 }]);
  });

  it("rolls edges up from the pre-rolled level edges onto the visible folder cards", () => {
    const s = buildScene(ix, { level: "mod", focus: "sys:app" }, "developer");
    const sharedCard = locate(ix, s, "mod:src-modules-shared")!;
    // Every module but shared imports shared with weight 2: each card's line carries 2 × its members (minus shared itself).
    for (const n of s.nodes.filter((x) => x.role === "cluster")) {
      const e = s.edges.find((x) => x.from === n.id && x.to === sharedCard);
      if (n.id === sharedCard) continue;
      const own = levelMembers(ix, { level: "mod", focus: "sys:app" }).filter((m) => locate(ix, s, m.id) === n.id && m.id !== "mod:src-modules-shared");
      expect(e?.weight, n.id).toBe(2 * own.length);
    }
    expect(s.edges.some((e) => e.from === e.to)).toBe(false);
  });

  it("a folder view shows its members, outside neighbours as a few ghosts, and a breadcrumb back", () => {
    const st: MapState = { level: "mod", focus: "sys:app", group: "src/modules" };
    const s = buildScene(ix, st, "developer");
    expect(cards(s).filter((n) => n.role === "card" || n.role === "cluster").length).toBeLessThanOrEqual(GROUP_LIMIT);
    expect(s.nodes.filter((n) => n.role === "ghost").length).toBeLessThanOrEqual(8);
    expect(breadcrumb(ix, st).map((c) => c.id ?? c.label)).toEqual(["sys", "sys:app", "dir:src/modules"]);
    expect(breadcrumb(ix, st)[1]!.state).toEqual({ level: "mod", focus: "sys:app" });
  });

  it("reveals a module inside the folders that hold it", () => {
    const t = revealTarget(ix, "mod:src-modules-area3-feature9");
    expect(t.level).toBe("mod");
    expect(t.group).toBeDefined();
    expect(locate(ix, buildScene(ix, t, "developer"), "mod:src-modules-area3-feature9")).toBe("mod:src-modules-area3-feature9");
  });

  it("modules of a few systems group inside each system's box", () => {
    const s = buildScene(ix, { level: "mod" }, "developer");
    expect(s.grouped).toBe(true);
    expect(s.nodes.filter((n) => n.role === "group").map((n) => n.id)).toEqual(["sys:app", "sys:tools"]);
    expect(s.nodes.filter((n) => n.role === "cluster").every((n) => n.parent === "sys:app")).toBe(true);
  });
});

describe("aggregate chips", () => {
  it("collapses connected entities and externals into one chip per kind, edges summed", () => {
    const s = buildScene(ix, { level: "sys" }, "developer");
    expect(s.aggregated).toEqual(["entity", "ext"]);
    const ext = s.nodes.find((n) => n.id === "agg:ext")!;
    expect(ext).toMatchObject({ role: "agg", kind: "ext", count: 9 });
    expect(s.edges.find((e) => e.from === "sys:app" && e.to === "agg:ext")?.weight).toBe(9);
    expect(s.edges.find((e) => e.from === "sys:app" && e.to === "agg:entity")?.weight).toBe(28 * 3);
    expect(locate(ix, s, "ext:svc3")).toBe("agg:ext");
  });

  it("opens a kind in place, and pins a single one out of its chip", () => {
    const open = buildScene(ix, { level: "sys", open: ["ext"] }, "developer");
    expect(open.nodes.filter((n) => n.kind === "ext").map((n) => n.role)).toEqual(Array(9).fill("chip"));
    const pinned = buildScene(ix, { level: "sys", open: ["ext:svc3"] }, "developer");
    expect(pinned.nodes.find((n) => n.id === "agg:ext")?.count).toBe(8);
    expect(locate(ix, pinned, "ext:svc3")).toBe("ext:svc3");
  });

  it("Business keeps up to eight of a kind as chips", () => {
    const biz = buildScene(buildIndex(monorepo(["src/a", "src/b"], { externals: 8, entities: 9, withBusiness: true })), { level: "biz" }, "developer");
    expect(biz.nodes.filter((n) => n.kind === "ext").map((n) => n.role)).toEqual(Array(8).fill("chip"));
    expect(biz.nodes.find((n) => n.id === "agg:entity")?.count).toBe(9);
  });

  it("small apps keep their few entities as chips", () => {
    const s = buildScene(buildIndex(shop), { level: "mod" }, "developer");
    expect(s.aggregated).toEqual([]);
  });
});

describe("same-name disambiguation", () => {
  it("adds the shortest folder tail that tells same-named items apart", () => {
    const m = disambiguate([
      { id: "1", label: "Admin", dir: ["src", "app", "admin"] },
      { id: "2", label: "Admin", dir: ["src", "modules", "admin"] },
      { id: "3", label: "Tests", dir: ["a", "x", "__tests__"] },
      { id: "4", label: "Tests", dir: ["b", "x", "__tests__"] },
      { id: "5", label: "Tests", dir: ["c", "__tests__"] },
      { id: "6", label: "README.md", dir: [] },
      { id: "7", label: "README.md", dir: ["docs"] },
      { id: "8", label: "Unique", dir: ["z"] },
    ]);
    expect(Object.fromEntries(m)).toEqual({
      "1": "Admin · app/admin",
      "2": "Admin · modules/admin",
      "3": "Tests · a/x/__tests__",
      "4": "Tests · b/x/__tests__",
      "5": "Tests · c/__tests__",
      "6": "README.md · /",
      "7": "README.md · docs",
    });
  });

  it("applies on map cards and in lists of nodes", () => {
    const small = buildIndex(monorepo(["src/app/admin", "src/modules/admin", "src/x"]));
    const s = buildScene(small, { level: "mod", focus: "sys:app" }, "developer");
    expect(s.nodes.map((n) => n.label).sort()).toEqual(["Admin · app/admin", "Admin · modules/admin", "X"]);
    expect(Object.fromEntries(nodeLabels(ix, ["mod:src-app-admin", "mod:src-modules-admin", "mod:src"]))).toEqual({
      "mod:src-app-admin": "Admin · app/admin",
      "mod:src-modules-admin": "Admin · modules/admin",
    });
  });
});

describe("a map without a business model", () => {
  it("opens on Systems and reveals entities there, pinned", () => {
    expect(ix.hasBusiness).toBe(false);
    expect(homeLevel(ix)).toBe("sys");
    expect(revealTarget(ix, "entity:E4")).toEqual({ level: "sys", open: ["entity:E4"] });
    expect(revealTarget(ix, "nope:x")).toEqual({ level: "sys" });
  });

  it("a map with one opens on Business", () => {
    const shopIx = buildIndex(shop);
    expect(shopIx.hasBusiness).toBe(true);
    expect(homeLevel(shopIx)).toBe("biz");
  });
});

describe("deep links to a folder", () => {
  const cases: Route[] = [
    { view: "map", level: "mod", focus: "sys:app", group: "src/modules" },
    { view: "map", level: "file", focus: "mod:db", group: "db/migrations~2", node: "file:db/migrations/a b.sql" },
    { view: "map", level: "file", group: "src/(shop)/[id]" },
  ];
  it.each(cases)("round-trips %j", (r) => {
    expect(parseHash(formatHash(r))).toEqual(r);
  });

  it("writes the group readably", () => {
    expect(formatHash({ view: "map", level: "mod", focus: "sys:app", group: "src/app~1" })).toBe("#level=mod&focus=sys:app&group=src/app~1");
  });
});

describe("card sublines", () => {
  const width = (x: string) => x.length * 6;
  const cut = (x: string) => `${x.slice(0, 8)}…`;
  it("drop the least telling counts instead of cutting words", () => {
    expect(fitParts(["3 modules", "1 route", "3 data models"], 10_000, width, cut)).toBe("3 modules · 1 route · 3 data models");
    expect(fitParts(["3 modules", "1 route", "3 data models"], 130, width, cut)).toBe("3 modules · 1 route");
    expect(fitParts(["3 modules", "1 route"], 60, width, cut)).toBe("3 modules");
    expect(fitParts(["a very long single part"], 60, width, cut)).toBe("a very l…");
  });
});
