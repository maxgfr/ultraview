import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap } from "../src/build.js";
import { checkMap, FILES_IN_SYSTEMS_MIN, MODULES_IN_CAPABILITIES_MIN } from "../src/check.js";
import { splitSentences, uncitedSentences } from "../src/model/prose.js";
import { saveFlow, saveLens } from "../src/save.js";
import { readStatus } from "../src/status.js";
import { builtShop, readModelFile, touch, writeView } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const model = () => readModelFile("shop.model.json");
const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

describe("prose rules", () => {
  it("splits sentences, keeping trailing citations with their sentence", () => {
    expect(splitSentences("Turns a cart into an order. [a/b.ts:1] Then it pays! [a/c.ts:2-3]\n\n- One item [x/y.ts:1]\n- Two")).toEqual([
      "Turns a cart into an order. [a/b.ts:1]",
      "Then it pays! [a/c.ts:2-3]",
      "One item [x/y.ts:1]",
      "Two",
    ]);
    expect(splitSentences("# Title\n\n```ts\nconst x = 1. Nope\n```\nDone here.")).toEqual(["Done here."]);
  });

  it("flags each substantive sentence without a citation", () => {
    expect(uncitedSentences("Places the order. [src/a.ts:3] It also emails a receipt to the customer.")).toEqual(["It also emails a receipt to the customer."]);
    expect(uncitedSentences("Short one. [src/a.ts:3] Ok.")).toEqual([]);
  });
});

describe("checkMap", () => {
  it("passes on the shop model with its lens and flow", async () => {
    const repo = await builtShop(cleanups, { views: true });
    const r = checkMap(repo);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.coverage).toEqual({ filesInSystems: 1, modulesInCapabilities: 1 });
    expect(r.thresholds).toEqual({ filesInSystems: FILES_IN_SYSTEMS_MIN, modulesInCapabilities: MODULES_IN_CAPABILITIES_MIN });
  });

  it("fails without a model, and on schema errors", async () => {
    const repo = await builtShop(cleanups, { model: false });
    expect(messages(checkMap(repo).errors)).toEqual(["missing: write it (systems first, then capabilities)"]);
    writeView(repo, "model.json", { schema: 1 });
    const r = checkMap(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => `${e.file} ${e.path}`)).toEqual([
      ".ultraview/model.json app",
      ".ultraview/model.json systems",
      ".ultraview/model.json capabilities",
    ]);
  });

  it("fails on a dead citation, an uncited sentence and an unresolved id", async () => {
    const m = model();
    m.capabilities[0].summary = "A customer orders a list of products. [src/services/orders.ts:999]";
    m.capabilities[1].summary += " It also emails a receipt to the customer.";
    m.capabilities[1].members.push("route:POST /api/nope");
    m.tour[0].node = "cap:checkout";
    m.edges[0].cite = "prisma/schema.prisma:200";
    m.glossary[0].meaning = "See [docs/missing.md:1].";
    const repo = await builtShop(cleanups, { model: m });
    const r = checkMap(repo);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      "capabilities[0].summary: dead citation [src/services/orders.ts:999]: line 999 out of range (1-27)",
      'capabilities[1].summary: uncited sentence: "It also emails a receipt to the customer."',
      'capabilities[1].members[5]: unknown node "route:POST /api/nope" (run `ultraview show <id>` on a known one, or see the build summary)',
      "edges[0].cite: dead citation [prisma/schema.prisma:200]: line 200 out of range (1-54)",
      'tour[0].node: unknown node "cap:checkout" (run `ultraview show <id>` on a known one, or see the build summary)',
      "glossary[0].meaning: dead citation [docs/missing.md:1]: no such file in the index",
    ]);
  });

  it("fails below the coverage thresholds", async () => {
    const m = model();
    m.capabilities = m.capabilities.filter((c: { id: string }) => c.id !== "health");
    m.systems = [{ ...m.systems[0], paths: ["src/routes/**", "src/services/**"] }];
    m.edges = [];
    m.tour = [m.tour[0]];
    const repo = await builtShop(cleanups, { model: m });
    const r = checkMap(repo);
    expect(r.coverage).toEqual({ filesInSystems: 0.4, modulesInCapabilities: 0.6667 });
    expect(r.errors.map((e) => e.path)).toEqual(["systems", "capabilities"]);
    expect(r.errors[0]!.message).toContain("systems hold 40.0% of code files, below 90.0%");
    expect(r.errors[1]!.message).toContain("capabilities claim 66.7% of non-test code modules, below 70.0%");
  });

  it("warns on a stale lens or flow after a cited file changes; --strict fails", async () => {
    const repo = await builtShop(cleanups, { views: true });
    touch(repo, "src/services/orders.ts");
    expect(messages(checkMap(repo).errors)[0]).toMatch(/^index is stale/);
    await buildMap({ repo, ast: false });
    const r = checkMap(repo);
    expect(r.ok).toBe(true);
    expect(r.stale).toEqual({ lenses: ["how-cancel-works"], flows: ["place-order"], prose: [] });
    expect(r.warnings.map((w) => w.file)).toEqual([".ultraview/lenses/how-cancel-works.json", ".ultraview/flows/place-order.json"]);
    const strict = checkMap(repo, { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.errors).toHaveLength(2);
    // Re-saving re-stamps the sources: fresh again.
    saveLens(repo, readModelFile("shop.lens.json"));
    saveFlow(repo, readModelFile("shop.flow.json"));
    expect(checkMap(repo, { strict: true }).ok).toBe(true);
  });

  it("reports invalid lens files and globs that match nothing", async () => {
    const m = model();
    m.capabilities[2].paths = ["src/helth/**"];
    const repo = await builtShop(cleanups, { model: m });
    writeView(repo, "lenses/oops.json", { ...readModelFile("shop.lens.json"), id: "other" });
    const r = checkMap(repo);
    expect(r.errors).toEqual([{ file: ".ultraview/lenses/oops.json", path: "id", message: '"other" must match the file name (oops.json)' }]);
    expect(r.warnings).toEqual([{ file: ".ultraview/model.json", path: "capabilities[2].paths[0]", message: 'glob "src/helth/**" matches no indexed file' }]);
  });
});

describe("lens save / flow save", () => {
  it("stamps the sha256 of every cited file and writes byte-stable JSON", async () => {
    const repo = await builtShop(cleanups);
    const input = { ...readModelFile("shop.lens.json"), sources: { "README.md": "forged" } };
    const r = saveLens(repo, JSON.stringify(input));
    expect(r).toMatchObject({ ok: true, file: ".ultraview/lenses/how-cancel-works.json", replaced: false, errors: [] });
    const sha = (rel: string) =>
      createHash("sha256")
        .update(readFileSync(join(repo, rel)))
        .digest("hex");
    expect(r.sources).toEqual({ "src/routes/orders.ts": sha("src/routes/orders.ts"), "src/services/orders.ts": sha("src/services/orders.ts") });
    const written = readFileSync(join(repo, r.file!), "utf8");
    expect(JSON.parse(written).sources).toEqual(r.sources);
    expect(written.endsWith("}\n")).toBe(true);
    expect(saveLens(repo, input).replaced).toBe(true);
    expect(readFileSync(join(repo, r.file!), "utf8")).toBe(written);

    const f = saveFlow(repo, readModelFile("shop.flow.json"));
    expect(Object.keys(f.sources)).toEqual(["src/routes/orders.ts", "src/server.ts", "src/services/orders.ts"]);
  });

  it("refuses a different question under the same id unless forced", async () => {
    const repo = await builtShop(cleanups);
    saveLens(repo, readModelFile("shop.lens.json"));
    const other = { ...readModelFile("shop.lens.json"), question: "Can a paid order be cancelled?" };
    const refused = saveLens(repo, other);
    expect(refused.ok).toBe(false);
    expect(refused.errors[0]!.message).toContain('already holds a different question ("How does cancelling an order work?")');
    const forced = saveLens(repo, other, { force: true });
    expect(forced).toMatchObject({ ok: true, replaced: true });
  });

  it("refuses invalid input and dead citations", async () => {
    const repo = await builtShop(cleanups);
    expect(saveLens(repo, "{").errors[0]!.message).toMatch(/^invalid JSON/);
    expect(saveLens(repo, { ...readModelFile("shop.lens.json"), id: "Bad Id" }).errors[0]!.path).toBe("id");
    const dead = saveFlow(repo, { ...readModelFile("shop.flow.json"), steps: [{ node: "entity:Order", note: "Written here. [src/nope.ts:1]" }] });
    expect(dead.ok).toBe(false);
    expect(messages(dead.errors)).toEqual(["dead citation [src/nope.ts:1]: no such file in the index", "cites src/nope.ts, which is not a file in the repo"]);
  });
});

describe("status", () => {
  it("routes no-model -> model-incomplete -> ready -> stale-views", async () => {
    const repo = await builtShop(cleanups, { model: false });
    expect(readStatus(repo).situation).toBe("no-model");

    const m = model();
    m.capabilities = m.capabilities.filter((c: { id: string }) => c.id !== "health");
    m.capabilities[0].summary += " It also emails a receipt to the customer.";
    writeView(repo, "model.json", m);
    const incomplete = readStatus(repo);
    expect(incomplete.situation).toBe("model-incomplete");
    expect(incomplete.check).toMatchObject({ ok: false, errors: 2 });
    expect(incomplete.worklist).toEqual([
      '.ultraview/model.json capabilities[0].summary: uncited sentence: "It also emails a receipt to the customer."',
      expect.stringContaining(".ultraview/model.json capabilities: capabilities claim 66.7%"),
      "run `ultraview check` until it passes",
    ]);

    writeView(repo, "model.json", model());
    expect(readStatus(repo).situation).toBe("ready");

    saveLens(repo, readModelFile("shop.lens.json"));
    touch(repo, "src/routes/orders.ts");
    expect(readStatus(repo).situation).toBe("index-stale");
    await buildMap({ repo, ast: false });
    const stale = readStatus(repo);
    expect(stale.situation).toBe("stale-views");
    expect(stale.reasons).toEqual(["stale lenses: how-cancel-works"]);
    expect(stale.worklist[0]).toContain(".ultraview/lenses/how-cancel-works.json: stale");
  });
});
