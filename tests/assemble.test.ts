import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap } from "../src/build.js";
import { stableJson } from "../src/json.js";
import { assembleView, assembleWithNotes, assignSystems, globSpecificity, humanizeSegment } from "../src/model/assemble.js";
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
    await expect(first).toMatchFileSnapshot("./__snapshots__/shop.view.json");
    await buildMap({ repo, ast: false });
    expect(readFileSync(join(repo, ".ultraview", "view.json"), "utf8")).toBe(first);
    expect(r.view).toMatchObject({ nodes: 39, coverage: { filesInSystems: 1, modulesInCapabilities: 1 }, oversize: false, problems: [] });
    expect(r.written).toContain(".ultraview/view.json");
  });

  it("builds the structural tree: sys > mod > file > sym / route / entity", async () => {
    const { inputs } = await shopInputs();
    const v = assembleView(inputs);
    expect(v.nodes.filter((n) => n.parent === "sys:api").map((n) => n.id)).toEqual(["mod:src", "mod:src-routes", "mod:src-services"]);
    expect(node(v, "mod:prisma")!.parent).toBe("sys:database");
    expect(node(v, "file:src/db.ts")!.parent).toBe("mod:src");
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
    expect(v.nodes.filter((n) => n.kind === "mod" && n.caps.includes("cap:_foundations")).map((n) => n.id)).toEqual(["mod:docs", "mod:root"]);
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
    // Everything under sys:api stays inside it: no sys:api -> sys:api roll-up.
    expect(v.edges.filter((e) => e.from === "sys:api" && e.to.startsWith("sys:"))).toEqual([]);
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
