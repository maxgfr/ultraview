import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { nodeDossier } from "../src/dossier.js";
import { formatNodeCard, liveView, nodeCard, similarIds } from "../src/show.js";
import { builtShop, captureIo, MODELS } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

async function run(argv: string[]) {
  const cap = captureIo();
  const code = await main(argv, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

describe("show", () => {
  it("prints a compact card per node", async () => {
    const repo = await builtShop(cleanups);
    const live = liveView(repo);
    const card = nodeCard(live, "cap:ordering")!;
    expect(card.members!.byKind).toEqual({ entity: 3, file: 3, mod: 3, route: 1, sym: 1, sys: 2 });
    expect(card.out[0]).toMatchObject({ to: "cap:order-tracking", kind: "call", weight: 3 });
    await expect(formatNodeCard(card)).toMatchFileSnapshot("./__snapshots__/shop.show-cap-ordering.txt");
    await expect(formatNodeCard(nodeCard(live, "entity:Order")!)).toMatchFileSnapshot("./__snapshots__/shop.show-entity-order.txt");
    expect(nodeCard(live, "sys:_unassigned")!.unassignedFiles).toEqual([]);
    // A module split across systems lists its slices; a slice names its module and system.
    expect(nodeCard(live, "mod:src")!.slices).toEqual(["mod:src@database"]);
    const slice = nodeCard(live, "mod:src@database")!;
    expect(slice).toMatchObject({ parent: "sys:database", slice: { of: "mod:src", system: "sys:database", qualifier: "@ Database" } });
    expect(slice.children.first).toEqual(["file:src/db.ts"]);
    expect(formatNodeCard(slice)).toContain("\nslice of  mod:src @ Database\n");
    expect(nodeCard(live, "cap:nope")).toBeUndefined();
    expect(similarIds(live.view, "cap:order")).toEqual(["cap:ordering", "entity:Order", "entity:OrderItem", "cap:order-tracking", "route:GET /api/orders"]);
  });

  it("show --json returns the card; an unknown id exits 2 with suggestions", async () => {
    const repo = await builtShop(cleanups);
    const r = await run(["show", "route:POST /api/orders", "--repo", repo, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ id: "route:POST /api/orders", parent: "file:src/routes/orders.ts", caps: ["cap:ordering"] });
    const bad = await run(["show", "cap:order", "--repo", repo]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown node id: cap:order (did you mean: cap:ordering, entity:Order");
    expect((await run(["show", "--repo", repo])).code).toBe(2);
  });
});

describe("dossier", () => {
  it("renders deterministic evidence packs per node kind", async () => {
    const repo = await builtShop(cleanups);
    const sys = nodeDossier(repo, "sys:database").text!;
    expect(sys).toContain("## Facts\nentities (4):\n- entity:Order (prisma)  [prisma/schema.prisma:36]");
    expect(sys).toContain("### src/db.ts");
    await expect(sys).toMatchFileSnapshot("./__snapshots__/shop.dossier-sys-database.txt");
    await expect(nodeDossier(repo, "cap:ordering").text!).toMatchFileSnapshot("./__snapshots__/shop.dossier-cap-ordering.txt");
    const entity = nodeDossier(repo, "entity:Order").text!;
    expect(entity).toContain("## Used at (3 site(s))\n\n### [src/services/orders.ts:9] read");
    await expect(entity).toMatchFileSnapshot("./__snapshots__/shop.dossier-entity-order.txt");
    const mod = nodeDossier(repo, "mod:src-services").text!;
    expect(mod).toMatch(/^# Dossier — module `src-services`/);
    expect(mod).toContain("## ultraview\nnode mod:src-services · parent sys:api · caps cap:order-tracking, cap:ordering");
    expect(nodeDossier(repo, "sys:database").text).toBe(sys);
    // A slice gets the whole module's engine dossier, then its own place in the map.
    const slice = nodeDossier(repo, "mod:src@database").text!;
    expect(slice).toMatch(/^# Dossier — module `src`/);
    expect(slice).toContain("## ultraview\nnode mod:src@database · parent sys:database · caps cap:_foundations\nslice of mod:src @ Database");
    expect(nodeDossier(repo, "mod:src").text!).toContain("node mod:src · parent sys:api · caps cap:health\nslices mod:src@database (@ Database)");
    expect(nodeDossier(repo, "mod:nope").text).toBeUndefined();
  });

  it("cuts to the budget", async () => {
    const repo = await builtShop(cleanups);
    const small = nodeDossier(repo, "cap:ordering", { budget: 300 }).text!;
    expect(small.length).toBeLessThanOrEqual(300 * 4 + 200);
    expect(small).toContain("cut to the ~300-token budget");
    const r = await run(["dossier", "cap:ordering", "--repo", repo, "--budget", "300"]);
    expect(r.out).toBe(small);
    expect((await run(["dossier", "cap:ordering", "--repo", repo, "--budget", "0"])).code).toBe(2);
    expect((await run(["dossier", "cap:zzz", "--repo", repo])).code).toBe(2);
  });
});

describe("cli: check, lens save, flow save", () => {
  it("check exits 0 when clean and 1 on failure", async () => {
    const repo = await builtShop(cleanups);
    const ok = await run(["check", "--repo", repo]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("check      ok");
    writeFileSync(join(repo, ".ultraview", "model.json"), '{ "schema": 1 }\n');
    const bad = await run(["check", "--repo", repo, "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ ok: false, errors: [{ file: ".ultraview/model.json", path: "app", message: "is required" }, {}, {}] });
  });

  it("lens save / flow save write under .ultraview and refuse overwrites without --force", async () => {
    const repo = await builtShop(cleanups);
    const lens = await run(["lens", "save", join(MODELS, "shop.lens.json"), "--repo", repo]);
    expect(lens.code).toBe(0);
    expect(lens.out).toContain("saved      .ultraview/lenses/how-cancel-works.json; sources: 2 cited file(s) hashed");
    const flow = await run(["flow", "save", join(MODELS, "shop.flow.json"), "--repo", repo, "--json"]);
    expect(JSON.parse(flow.out)).toMatchObject({ ok: true, file: ".ultraview/flows/place-order.json" });

    const draft = join(repo, "draft.json");
    writeFileSync(draft, JSON.stringify({ schema: 1, id: "how-cancel-works", question: "Other?", answer: "Yes. [src/server.ts:1]", nodes: [] }));
    const refused = await run(["lens", "save", draft, "--repo", repo]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("already holds a different question");
    expect((await run(["lens", "save", draft, "--repo", repo, "--force"])).code).toBe(0);
    expect((await run(["lens", "list", "--repo", repo])).code).toBe(2);
    expect((await run(["lens", "save", "/definitely/missing.json", "--repo", repo])).code).toBe(1);
  });
});
