import { describe, expect, it } from "vitest";
import { parseJson, validateFlow, validateLens, validateModel, validateTimelineEntry } from "../src/model/validate.js";
import { readModelFile } from "./helpers.js";

const model = () => readModelFile("shop.model.json");
const paths = (ps: { path: string }[]) => ps.map((p) => p.path);

describe("validateModel", () => {
  it("accepts the shop model", () => {
    expect(validateModel(model())).toEqual([]);
  });

  it("rejects unknown keys (typos) with their path", () => {
    const m = model();
    m.capabilities[1].sumary = "typo";
    m.extra = 1;
    const problems = validateModel(m);
    expect(paths(problems)).toEqual(["capabilities[1].sumary", "extra"]);
    expect(problems[0]!.message).toContain('unknown key "sumary"');
  });

  it("requires fields and checks types", () => {
    const m = model();
    delete m.systems[0].paths;
    m.systems[1].label = 3;
    m.app = "Shop";
    expect(validateModel(m)).toEqual([
      { path: "app", message: "must be an object (got string)" },
      { path: "systems[0].paths", message: "is required" },
      { path: "systems[1].label", message: "must be a string (got number)" },
    ]);
  });

  it("checks the schema version, id shape, enums and duplicates", () => {
    const m = model();
    m.schema = 2;
    m.systems[0].id = "Main_Server";
    m.systems[1].kind = "database";
    m.app.audience = "managers";
    m.capabilities[2].id = "ordering";
    m.edges[0].kind = "soap";
    const ps = validateModel(m);
    expect(paths(ps)).toEqual(["schema", "app.audience", "systems[0].id", "systems[1].kind", "edges[0].kind", "capabilities[2].id"]);
    expect(ps.find((p) => p.path === "capabilities[2].id")!.message).toContain('duplicate id "ordering"');
    expect(ps.find((p) => p.path === "systems[0].id")!.message).toContain("not a valid id");
  });

  it("checks member ids: known prefix, allowed kind, well-formed, unique", () => {
    const m = model();
    m.capabilities[0].members = ["foo:bar", "cap:order-tracking", "route:post /api/orders", "entity:Order", "entity:Order", "sym:src/a.ts#"];
    const ps = validateModel(m);
    expect(paths(ps)).toEqual([
      "capabilities[0].members[0]",
      "capabilities[0].members[1]",
      "capabilities[0].members[2]",
      "capabilities[0].members[4]",
      "capabilities[0].members[5]",
    ]);
    expect(ps[0]!.message).toContain("is not a node id");
    expect(ps[1]!.message).toContain("a cap: id is not allowed here");
    expect(ps[2]!.message).toContain("malformed route: id");
    expect(ps[3]!.message).toContain('duplicate "entity:Order"');
  });

  it("refuses empty prose and empty path lists", () => {
    const m = model();
    m.capabilities[0].summary = "  ";
    m.systems[0].paths = [];
    expect(paths(validateModel(m))).toEqual(["systems[0].paths", "capabilities[0].summary"]);
  });
});

describe("validateFlow / validateLens / validateTimelineEntry", () => {
  it("accepts the shop flow and lens", () => {
    expect(validateFlow(readModelFile("shop.flow.json"))).toEqual([]);
    expect(validateLens(readModelFile("shop.lens.json"))).toEqual([]);
  });

  it("reports flow and lens problems with paths", () => {
    const f = readModelFile("shop.flow.json");
    f.steps[1].node = "placeOrder";
    f.trigger = 1;
    expect(paths(validateFlow(f))).toEqual(["trigger", "steps[1].node"]);
    expect(paths(validateFlow({ ...readModelFile("shop.flow.json"), steps: [] }))).toEqual(["steps"]);

    const l = readModelFile("shop.lens.json");
    delete l.answer;
    l.edges[0].kind = "uses";
    l.sources = { "src/a.ts": 3 };
    expect(paths(validateLens(l))).toEqual(["answer", "edges[0].kind", "sources.src/a.ts"]);
  });

  it("validates timeline entries", () => {
    const entry = {
      at: "2026-11-26T10:00:00Z",
      source: "agent",
      title: "Add refunds",
      summary: "Refunds go through the order service. [src/services/orders.ts:24]",
      items: [{ ref: "route:POST /api/refunds", change: "new" }],
    };
    expect(validateTimelineEntry(entry)).toEqual([]);
    expect(paths(validateTimelineEntry({ ...entry, source: "bot", items: [{ ref: "x", change: "added" }] }))).toEqual([
      "source",
      "items[0].ref",
      "items[0].change",
    ]);
  });

  it("turns a JSON syntax error into a problem", () => {
    const r = parseJson("{ nope");
    expect(r.value).toBeUndefined();
    expect(r.problems[0]!.message).toMatch(/^invalid JSON/);
  });
});
