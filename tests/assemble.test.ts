import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap } from "../src/build.js";
import { stableJson } from "../src/json.js";
import type { Graph } from "../src/engine.js";
import { emptyFacts } from "../src/extract/index.js";
import {
  assembleView,
  assembleWithNotes,
  assignSystems,
  globSpecificity,
  humanizeSegment,
  LINKS_PER_FILE,
  routeEdgeKind,
  systemOfFile,
  systemRules,
  type ViewInputs,
  type WorkspaceRef,
} from "../src/model/assemble.js";
import { loadViewInputs } from "../src/model/load.js";
import type { Model, ViewModel } from "../src/model/types.js";
import { builtShop, readModelFile } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const node = (v: ViewModel, id: string) => v.nodes.find((n) => n.id === id);
const edge = (v: ViewModel, from: string, to: string, kind: string) => v.edges.find((e) => e.from === from && e.to === to && e.kind === kind);

async function shopInputs(model?: Model | false) {
  const repo = await builtShop(cleanups);
  const loaded = loadViewInputs(repo);
  return { repo, inputs: model === undefined ? loaded.inputs : { ...loaded.inputs, model: model || undefined } };
}

describe("assembleView", () => {
  it("writes a byte-stable view.json for the shop fixture", async () => {
    const repo = await builtShop(cleanups, { views: true });
    // Rebuild so the saved lens and flow are in the view.
    const r = await buildMap({ repo, ast: false });
    const first = readFileSync(join(repo, ".ultraview", "view.json"), "utf8");
    // repo.root is the machine-local absolute path: the only part that differs between machines.
    expect(JSON.parse(first).repo.root).toBe(repo);
    await expect(first.replace(JSON.stringify(repo), '"<repo>"')).toMatchFileSnapshot("./__snapshots__/shop.view.json");
    await buildMap({ repo, ast: false });
    expect(readFileSync(join(repo, ".ultraview", "view.json"), "utf8")).toBe(first);
    expect(r.view).toMatchObject({ nodes: 40, coverage: { filesInSystems: 1, modulesInCapabilities: 1 }, oversize: false, problems: [] });
    expect(r.written).toContain(".ultraview/view.json");
  });

  it("builds the structural tree: sys > mod > file > sym / route / entity", async () => {
    const { inputs } = await shopInputs();
    const v = assembleView(inputs);
    expect(v.nodes.filter((n) => n.parent === "sys:api").map((n) => n.id)).toEqual(["mod:src", "mod:src-routes", "mod:src-services"]);
    expect(node(v, "mod:prisma")!.parent).toBe("sys:database");
    // src/db.ts is in sys:database by its glob, so it hangs under mod:src's slice there.
    expect(node(v, "file:src/db.ts")!.parent).toBe("mod:src@database");
    expect(node(v, "file:src/server.ts")!.parent).toBe("mod:src");
    expect(node(v, "mod:src@database")).toMatchObject({
      kind: "mod",
      label: "Src",
      parent: "sys:database",
      tags: ["slice", "tier-1"],
      slice: { of: "mod:src", system: "sys:database", qualifier: "@ Database" },
    });
    expect(node(v, "mod:src")!.slice).toBeUndefined();
    expect(v.nodes.filter((n) => n.parent === "sys:database").map((n) => n.id)).toEqual(["mod:prisma", "mod:src@database"]);
    expect(node(v, "sym:src/services/orders.ts#placeOrder")).toMatchObject({
      parent: "file:src/services/orders.ts",
      at: "src/services/orders.ts:12",
      label: "placeOrder",
    });
    expect(node(v, "route:DELETE /api/orders/:id")).toMatchObject({
      parent: "file:src/routes/orders.ts",
      at: "src/routes/orders.ts:19",
      label: "DELETE /api/orders/:id",
    });
    expect(node(v, "entity:Order")).toMatchObject({ parent: "file:prisma/schema.prisma", tags: ["prisma"] });
    expect(node(v, "entity:Order")!.fields!.find((f) => f.name === "user")).toEqual({ name: "user", type: "User", relation: "User" });
    expect(node(v, "mod:src-routes")!.label).toBe("Routes");
    expect(node(v, "mod:root")!.label).toBe("Root");
    // Only exported top-level symbols, one node per name.
    expect(v.nodes.filter((n) => n.kind === "sym" && n.parent === "file:src/server.ts").map((n) => n.id)).toEqual(["sym:src/server.ts#app"]);
    // Model labels and summaries, with their citations.
    expect(node(v, "sys:api")).toMatchObject({ label: "Main server", role: "service", cites: ["src/server.ts:7"] });
    expect(v.app).toMatchObject({ name: "Shop", audience: "everyone", cites: ["README.md:3"] });
  });

  it("puts files no system matches under sys:_unassigned and counts only code files in coverage", async () => {
    const { inputs } = await shopInputs();
    const { view, fileSystems } = assembleWithNotes(inputs);
    expect(fileSystems.get("src/db.ts")).toBe("sys:database"); // most specific glob wins
    expect(fileSystems.get("README.md")).toBe("sys:_unassigned");
    expect(node(view, "mod:docs")!.parent).toBe("sys:_unassigned");
    expect(view.coverage.filesInSystems).toBe(1);

    const narrow = readModelFile("shop.model.json") as Model;
    narrow.systems = [{ ...narrow.systems[0]!, paths: ["src/routes/**"] }];
    const v2 = assembleWithNotes({ ...inputs, model: narrow });
    expect(v2.view.coverage.filesInSystems).toBe(0.2); // 1 of 5 code files
    expect(node(v2.view, "mod:src")!.parent).toBe("sys:_unassigned");
  });

  it("assigns systems by the most specific glob, ties by declaration order, honoring exclude", () => {
    const files = ["src/db.ts", "src/a.ts", "src/a.test.ts", "prisma/schema.prisma", "docs/x.md"];
    const sys = (id: string, paths: string[], exclude?: string[]) => ({ id, label: id, kind: "service" as const, paths, ...(exclude ? { exclude } : {}) });
    const empty: { path: string; glob: string }[] = [];
    const out = assignSystems(files, [sys("api", ["src/**"], ["**/*.test.ts"]), sys("db", ["prisma", "src/db.ts"]), sys("twin", ["src/**", "lib/**"])], empty);
    expect(Object.fromEntries(out)).toEqual({
      "src/db.ts": "sys:db",
      "src/a.ts": "sys:api",
      "src/a.test.ts": "sys:twin",
      "prisma/schema.prisma": "sys:db",
      "docs/x.md": "sys:_unassigned",
    });
    expect(empty).toEqual([{ path: "systems[2].paths[1]", glob: "lib/**" }]);
    expect(globSpecificity("apps/web/src/cart/**")).toBeGreaterThan(globSpecificity("apps/web/**"));
    expect(humanizeSegment("src/order-history")).toBe("Order history");
  });

  it("overlays capabilities: claims cover descendants, aggregate upward, the rest are shared foundations", async () => {
    const { inputs } = await shopInputs();
    const v = assembleView(inputs);
    expect(node(v, "route:POST /api/orders")!.caps).toEqual(["cap:ordering"]);
    expect(node(v, "file:src/services/orders.ts")!.caps).toEqual(["cap:order-tracking", "cap:ordering"]);
    expect(node(v, "mod:src")!.caps).toEqual(["cap:health"]);
    expect(node(v, "mod:prisma")!.caps).toEqual(["cap:ordering"]); // via entity:Order
    expect(node(v, "sys:api")!.caps).toEqual(["cap:health", "cap:order-tracking", "cap:ordering"]);
    expect(node(v, "file:src/server.test.ts")!.caps).toEqual([]);
    expect(node(v, "cap:_foundations")).toMatchObject({ label: "Shared foundations", tags: ["derived"] });
    // The slice of mod:src in sys:database serves no capability (cap:health claims a route in server.ts).
    expect(v.nodes.filter((n) => n.kind === "mod" && n.caps.includes("cap:_foundations")).map((n) => n.id)).toEqual([
      "mod:docs",
      "mod:root",
      "mod:src@database",
    ]);
    expect(node(v, "file:README.md")!.caps).toEqual(["cap:_foundations"]);
    expect(v.coverage.modulesInCapabilities).toBe(1);

    // Without the health capability, mod:src is claimed by nothing.
    const m = readModelFile("shop.model.json") as Model;
    m.capabilities = m.capabilities.filter((c) => c.id !== "health");
    const v2 = assembleView({ ...inputs, model: m });
    expect(node(v2, "mod:src")!.caps).toEqual(["cap:_foundations"]);
    expect(node(v2, "file:src/server.test.ts")!.caps).toEqual(["cap:_foundations"]);
    expect(v2.coverage.modulesInCapabilities).toBe(0.6667);
  });

  it("rolls file edges up to module, system and capability level, without self-loops", async () => {
    const { inputs } = await shopInputs();
    const v = assembleView(inputs);
    expect(edge(v, "file:src/routes/orders.ts", "file:src/services/orders.ts", "call")).toMatchObject({ weight: 3, derived: true });
    expect(edge(v, "file:src/services/orders.ts", "entity:Order", "data")).toMatchObject({ weight: 3, label: "read+write" });
    expect(edge(v, "entity:Order", "entity:User", "data")).toMatchObject({ weight: 1, label: "user" });
    expect(edge(v, "mod:src-routes", "mod:src-services", "call")).toMatchObject({ weight: 3, derived: true });
    expect(edge(v, "mod:src-routes", "mod:src-services", "import")).toMatchObject({ weight: 1 });
    expect(edge(v, "mod:src-services", "entity:Order", "data")!.weight).toBe(3);
    expect(edge(v, "sys:api", "entity:Order", "data")!.weight).toBe(3);
    expect(edge(v, "cap:ordering", "cap:order-tracking", "call")!.weight).toBe(3);
    expect(edge(v, "cap:health", "cap:ordering", "import")!.weight).toBe(1);
    expect(v.edges.filter((e) => e.from === e.to)).toEqual([]);
    // The services import src/db.ts, which sits in sys:database: the roll-up crosses systems.
    expect(edge(v, "mod:src-services", "mod:src@database", "import")).toMatchObject({ weight: 1, derived: true });
    expect(v.edges.filter((e) => e.from === "sys:api" && e.to.startsWith("sys:"))).toEqual([
      { from: "sys:api", to: "sys:database", kind: "import", weight: 1, derived: true },
    ]);
    // The hand-written edge is not derived and keeps its citation.
    expect(edge(v, "sys:database", "sys:api", "config")).toEqual({
      from: "sys:database",
      to: "sys:api",
      kind: "config",
      weight: 1,
      derived: false,
      label: "connection string from DATABASE_URL",
      cite: "prisma/schema.prisma:10",
    });
  });

  it("derives a single sys:app without a model", async () => {
    const { inputs } = await shopInputs(false);
    const v = assembleView(inputs);
    expect(v.nodes.filter((n) => n.kind === "sys").map((n) => n.id)).toEqual(["sys:app"]);
    expect(v.nodes.filter((n) => n.kind === "mod").every((n) => n.parent === "sys:app")).toBe(true);
    expect(v.nodes.filter((n) => n.kind === "cap").map((n) => n.id)).toEqual(["cap:_foundations"]);
    expect(v.coverage).toEqual({ filesInSystems: 1, modulesInCapabilities: 0 });
    expect(v.app).toEqual({ name: "shop-express-prisma", cites: [], audience: "everyone" });
  });

  it("is deterministic: same inputs in any order give the same bytes", async () => {
    const { inputs } = await shopInputs();
    const a = stableJson(assembleView(inputs));
    const g = inputs.graph;
    const shuffled = { ...g, files: [...g.files].reverse(), modules: [...g.modules].reverse(), fileEdges: [...g.fileEdges].reverse() };
    expect(stableJson(assembleView({ ...inputs, graph: shuffled }))).toBe(a);
    expect(stableJson(assembleView(inputs))).toBe(a);
  });
});

/** A hand-made graph: files `[rel, module, lines, pagerank]`, module PageRank 1 each, edges `[from, to, kind, weight]`. */
function syntheticInputs(
  files: [string, string, number, number][],
  edges: [string, string, string, number][],
  model?: Partial<Model>,
  workspaces: WorkspaceRef[] = [],
): ViewInputs {
  const slugs = [...new Set(files.map((f) => f[1]))];
  const graph = {
    files: files.map(([rel, module, lines, pagerank]) => ({ rel, module, lines, pagerank, fileKind: "code" })),
    modules: slugs.map((slug) => ({ slug, path: slug, tier: 1, pagerank: 1 })),
    fileEdges: edges.map(([from, to, kind, weight]) => ({ from, to, kind, weight })),
  } as unknown as Graph;
  return {
    repoName: "synthetic",
    graph,
    facts: emptyFacts(),
    model: model ? ({ schema: 1, app: { name: "Synthetic" }, systems: [], capabilities: [], ...model } as Model) : undefined,
    workspaces,
    flows: [],
    lenses: [],
    timeline: [],
    moduleProse: new Map(),
    proseStale: [],
    currentHashes: new Map(),
  };
}

const system = (id: string, paths: string[]) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), kind: "service" as const, paths });

describe("module slices", () => {
  // mod:core spans three systems (3 files in web, 1 in data, 1 in worker); mod:ui sits in web.
  const files: [string, string, number, number][] = [
    ["core/a.ts", "core", 10, 0.1],
    ["core/b.ts", "core", 20, 0.1],
    ["core/c.ts", "core", 30, 0.2],
    ["core/db.ts", "core", 40, 0.4],
    ["core/jobs.ts", "core", 50, 0.2],
    ["ui/page.ts", "ui", 5, 0.5],
  ];
  const edges: [string, string, string, number][] = [
    ["core/a.ts", "core/db.ts", "import", 2],
    ["core/b.ts", "core/db.ts", "import", 1],
    ["core/jobs.ts", "core/db.ts", "call", 1],
    ["ui/page.ts", "core/jobs.ts", "import", 1],
    ["ui/page.ts", "core/a.ts", "import", 1],
  ];
  const model: Partial<Model> = {
    systems: [system("web", ["core/**", "ui/**"]), system("data", ["core/db.ts"]), system("worker", ["core/jobs.ts"])],
    capabilities: [
      { id: "storage", label: "Storage", members: ["mod:core"] },
      { id: "ops", label: "Operations", members: ["mod:core@worker"] },
    ],
  };
  const inputs = syntheticInputs(files, edges, model);

  it("splits a module across three systems: the majority keeps the id, each other system gets a slice", () => {
    const v = assembleView(inputs);
    const mods = v.nodes.filter((n) => n.kind === "mod").map((n) => ({ id: n.id, parent: n.parent, label: n.label, tags: n.tags, slice: n.slice }));
    expect(mods).toEqual([
      { id: "mod:core", parent: "sys:web", label: "Core", tags: ["tier-1"], slice: undefined },
      { id: "mod:core@data", parent: "sys:data", label: "Core", tags: ["slice", "tier-1"], slice: { of: "mod:core", system: "sys:data", qualifier: "@ Data" } },
      {
        id: "mod:core@worker",
        parent: "sys:worker",
        label: "Core",
        tags: ["slice", "tier-1"],
        slice: { of: "mod:core", system: "sys:worker", qualifier: "@ Worker" },
      },
      { id: "mod:ui", parent: "sys:web", label: "Ui", tags: ["tier-1"], slice: undefined },
    ]);
    expect(node(v, "file:core/db.ts")!.parent).toBe("mod:core@data");
    expect(node(v, "file:core/jobs.ts")!.parent).toBe("mod:core@worker");
    expect(node(v, "file:core/c.ts")!.parent).toBe("mod:core");
    // Metrics per slice: its own files' lines; the module's PageRank shared out by file PageRank.
    expect([node(v, "mod:core")!.metrics, node(v, "mod:core@data")!.metrics, node(v, "mod:core@worker")!.metrics]).toEqual([
      { loc: 60, pagerank: 0.4, churn: 0, tests: 0 },
      { loc: 40, pagerank: 0.4, churn: 0, tests: 0 },
      { loc: 50, pagerank: 0.2, churn: 0, tests: 0 },
    ]);
    expect(node(v, "sys:data")!.metrics.loc).toBe(40);
    expect(node(v, "sys:web")!.metrics.loc).toBe(65);
  });

  it("rolls edges up over slices, so they cross systems where the files do", () => {
    const v = assembleView(inputs);
    expect(edge(v, "mod:core", "mod:core@data", "import")).toMatchObject({ weight: 3, derived: true });
    expect(edge(v, "mod:core@worker", "mod:core@data", "call")!.weight).toBe(1);
    expect(edge(v, "mod:ui", "mod:core@worker", "import")!.weight).toBe(1);
    expect(edge(v, "mod:ui", "mod:core", "import")!.weight).toBe(1);
    expect(edge(v, "sys:web", "sys:data", "import")!.weight).toBe(3);
    expect(edge(v, "sys:worker", "sys:data", "call")!.weight).toBe(1);
    expect(edge(v, "sys:web", "sys:worker", "import")!.weight).toBe(1);
    // Inside one slice / one system nothing rolls up onto itself.
    expect(v.edges.filter((e) => e.from === e.to)).toEqual([]);
    expect(v.edges.filter((e) => e.from === "sys:web" && e.to === "sys:web")).toEqual([]);
    // Capability level: ops (the worker slice only) reaches storage once.
    expect(edge(v, "cap:ops", "cap:storage", "call")!.weight).toBe(1);
    expect(edge(v, "cap:_foundations", "cap:storage", "import")!.weight).toBe(2);
  });

  it("applies a capability member given as mod:<slug> to every slice, a slice id to that slice only", () => {
    const v = assembleView(inputs);
    expect(node(v, "mod:core")!.caps).toEqual(["cap:storage"]);
    expect(node(v, "mod:core@data")!.caps).toEqual(["cap:storage"]);
    expect(node(v, "mod:core@worker")!.caps).toEqual(["cap:ops", "cap:storage"]);
    expect(node(v, "file:core/db.ts")!.caps).toEqual(["cap:storage"]);
    expect(node(v, "sys:data")!.caps).toEqual(["cap:storage"]);
    expect(node(v, "mod:ui")!.caps).toEqual(["cap:_foundations"]);
    expect(v.coverage).toEqual({ filesInSystems: 1, modulesInCapabilities: 0.5 }); // core counts once, ui is unclaimed

    // Claiming only one slice claims the module for coverage, and leaves its other slices in the foundations.
    const v2 = assembleView({ ...inputs, model: { ...inputs.model!, capabilities: [{ id: "ops", label: "Operations", members: ["mod:core@worker"] }] } });
    expect(node(v2, "mod:core")!.caps).toEqual(["cap:_foundations"]);
    expect(node(v2, "mod:core@worker")!.caps).toEqual(["cap:ops"]);
    expect(v2.coverage.modulesInCapabilities).toBe(0.5);
  });

  it("breaks a tie by declaration order, and slices into sys:_unassigned too", () => {
    const v = assembleView(
      syntheticInputs(
        [
          ["lib/x.ts", "lib", 1, 0],
          ["lib/y.ts", "lib", 1, 0],
          ["misc/p.ts", "misc", 1, 0],
          ["misc/q.ts", "misc", 1, 0],
          ["misc/r.ts", "misc", 1, 0],
        ],
        [],
        { systems: [system("first", ["lib/y.ts"]), system("second", ["lib/x.ts", "misc/q.ts"])] },
      ),
    );
    expect(node(v, "mod:lib")!.parent).toBe("sys:first"); // 1 file each: the system declared first
    expect(node(v, "mod:lib@second")!.parent).toBe("sys:second");
    expect(node(v, "mod:lib")!.metrics.pagerank).toBe(0.5); // no file PageRank: shared by file count
    expect(node(v, "mod:misc")!.parent).toBe("sys:_unassigned"); // 2 unmatched files against 1
    expect(node(v, "mod:misc@second")).toMatchObject({ parent: "sys:second", slice: { of: "mod:misc", system: "sys:second", qualifier: "@ Second" } });

    const tie = assembleView(
      syntheticInputs(
        [
          ["m/a.ts", "m", 1, 0],
          ["m/b.ts", "m", 1, 0],
        ],
        [],
        { systems: [system("only", ["m/a.ts"])] },
      ),
    );
    expect(node(tie, "mod:m")!.parent).toBe("sys:only"); // a tie with _unassigned goes to the declared system
    expect(node(tie, "mod:m@_unassigned")).toMatchObject({ parent: "sys:_unassigned", slice: { qualifier: "@ Unassigned" } });
  });

  it("slices a module only when it spans workspaces, without a model", () => {
    const ws = [
      { name: "web", dir: "apps/web" },
      { name: "api", dir: "apps/api" },
    ];
    const v = assembleView(
      syntheticInputs(
        [
          ["apps/web/x.ts", "apps", 1, 0.1],
          ["apps/api/y.ts", "apps", 1, 0.1],
          ["apps/api/z.ts", "apps", 1, 0.2],
          ["apps/api/lib/w.ts", "apps-api-lib", 1, 0.1],
        ],
        [],
        undefined,
        ws,
      ),
    );
    expect(v.nodes.filter((n) => n.kind === "mod").map((n) => `${n.id} < ${n.parent}`)).toEqual([
      "mod:apps < sys:apps-api",
      "mod:apps-api-lib < sys:apps-api",
      "mod:apps@apps-web < sys:apps-web",
    ]);
    expect(node(v, "mod:apps-api-lib")!.metrics.pagerank).toBe(1); // unsplit: the module's own PageRank
  });

  it("places every file under the system systemOfFile gives it, the one rule coverage, show and check read", async () => {
    const { inputs: shop } = await shopInputs();
    const { view, fileSystems } = assembleWithNotes(shop);
    const rules = systemRules(shop.model, shop.workspaces);
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const systemAbove = (id: string) => {
      let cur = byId.get(id);
      while (cur && cur.kind !== "sys") cur = cur.parent ? byId.get(cur.parent) : undefined;
      return cur?.id;
    };
    for (const f of view.nodes.filter((n) => n.kind === "file")) {
      const rel = f.id.slice("file:".length);
      expect(systemAbove(f.id), rel).toBe(systemOfFile(rules, rel));
      expect(fileSystems.get(rel), rel).toBe(systemOfFile(rules, rel));
    }
    expect(systemOfFile(rules, "src/db.ts")).toBe("sys:database");
    expect(systemOfFile(systemRules(undefined, []), "anything.ts")).toBe("sys:app");
  });

  it("is deterministic over slices: same inputs in any order give the same bytes", () => {
    const a = stableJson(assembleView(inputs));
    const g = inputs.graph;
    const shuffled = { ...g, files: [...g.files].reverse(), modules: [...g.modules].reverse(), fileEdges: [...g.fileEdges].reverse() };
    expect(stableJson(assembleView({ ...inputs, graph: shuffled }))).toBe(a);
    expect(stableJson(assembleView(inputs))).toBe(a);
  });
});

describe("rpc edges, outbound links and infra overlays", () => {
  const files: [string, string, number, number][] = [
    ["web/page.tsx", "web", 10, 0.2],
    ["web/form.tsx", "web", 10, 0.2],
    ["api/router.ts", "api", 20, 0.3],
    ["api/actions.ts", "api", 20, 0.3],
    ["api/rest.ts", "api", 20, 0.3],
  ];
  const model: Partial<Model> = { systems: [system("front", ["web/**"]), system("back", ["api/**"])] };
  const inputs = (): ViewInputs => {
    const inp = syntheticInputs(files, [], model);
    const f = inp.facts;
    f.routes.push(
      { method: "QUERY", path: "user.byId", file: "api/router.ts", line: 3, framework: "trpc" },
      { method: "MUTATION", path: "user.update", file: "api/router.ts", line: 9, framework: "trpc" },
      { method: "ACTION", path: "api/actions#save", file: "api/actions.ts", line: 2, framework: "next-action", handler: "save" },
      { method: "GET", path: "/api/health", file: "api/rest.ts", line: 1, framework: "next-app" },
    );
    f.calls.push(
      { method: "QUERY", url: "user.byId", file: "web/page.tsx", line: 4, route: "route:QUERY user.byId" },
      { method: "MUTATION", url: "user.update", file: "web/form.tsx", line: 7, route: "route:MUTATION user.update" },
      { method: "ACTION", url: "api/actions#save", file: "web/form.tsx", line: 12, route: "route:ACTION api/actions#save" },
      { method: "GET", url: "/api/health", file: "web/page.tsx", line: 8, route: "route:GET /api/health" },
    );
    f.links = [
      ...Array.from({ length: 12 }, (_, i) => ({ host: `site${i}.org`, file: "web/page.tsx", line: 40 - i })),
      { host: "cnil.fr", file: "web/form.tsx", line: 5 },
      { host: "cnil.fr", file: "web/form.tsx", line: 5 },
      { host: "gone.org", file: "nowhere/file.ts", line: 1 },
    ];
    f.infra.push(
      { id: "db", kind: "compose-service", file: "docker-compose.yml", line: 4, overlays: ["env/prod/db.yaml", "env/dev/db.yaml"] },
      { id: "api", kind: "dockerfile", file: "api/Dockerfile", line: 1 },
    );
    return inp;
  };

  it("tells an RPC route from an HTTP one", () => {
    expect(["route:QUERY a.b", "route:MUTATION a", "route:SUBSCRIPTION a.c", "route:ACTION app/actions#save"].map(routeEdgeKind)).toEqual([
      "rpc",
      "rpc",
      "rpc",
      "rpc",
    ]);
    expect(["route:GET /x", "route:ALL /y", "route:POST /q"].map(routeEdgeKind)).toEqual(["http", "http", "http"]);
  });

  it("draws calls to tRPC procedures and server actions as rpc, at file level and rolled up", () => {
    const v = assembleView(inputs());
    expect(edge(v, "file:web/page.tsx", "route:QUERY user.byId", "rpc")).toMatchObject({ weight: 1, derived: true });
    expect(edge(v, "file:web/form.tsx", "route:MUTATION user.update", "rpc")).toBeDefined();
    expect(edge(v, "file:web/form.tsx", "route:ACTION api/actions#save", "rpc")).toBeDefined();
    expect(edge(v, "file:web/page.tsx", "route:GET /api/health", "http")).toBeDefined();
    expect(v.edges.filter((e) => e.kind === "http" && e.to.startsWith("route:") && !e.to.startsWith("route:GET"))).toEqual([]);
    // Roll-ups keep the kind: module and system level.
    expect(edge(v, "mod:web", "mod:api", "rpc")!.weight).toBe(3);
    expect(edge(v, "mod:web", "mod:api", "http")!.weight).toBe(1);
    expect(edge(v, "sys:front", "sys:back", "rpc")!.weight).toBe(3);
  });

  it("puts a file's outbound links on its node (by line, deduplicated, capped), never on the map", () => {
    const v = assembleView(inputs());
    const page = node(v, "file:web/page.tsx")!;
    expect(page.links).toHaveLength(LINKS_PER_FILE);
    expect(page.links![0]).toEqual({ host: "site11.org", line: 29 });
    expect(page.links!.map((l) => l.line)).toEqual([...page.links!.map((l) => l.line)].sort((a, b) => a - b));
    expect(node(v, "file:web/form.tsx")!.links).toEqual([{ host: "cnil.fr", line: 5 }]);
    expect(node(v, "file:api/rest.ts")!.links).toBeUndefined();
    expect(v.edges.some((e) => /site\d|cnil/.test(e.to))).toBe(false);
    expect(v.nodes.some((n) => /cnil|site\d/.test(n.id))).toBe(false);
  });

  it("keeps an infra unit's overlays, sorted, on its node", () => {
    const v = assembleView(inputs());
    expect(node(v, "infra:db")!.overlays).toEqual(["env/dev/db.yaml", "env/prod/db.yaml"]);
    expect(node(v, "infra:api")!.overlays).toBeUndefined();
  });
});
