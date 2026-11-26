// The node-id repair made before a lens's or a turn's gates (src/gates.ts
// `repairAnswerIds`), through `lens save`, `lens save --thread` and saveTurn.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatNew, loadConversation, saveTurn } from "../src/chat.js";
import { main } from "../src/cli.js";
import { repairAnswerIds, repairNodeId } from "../src/gates.js";
import { saveLens } from "../src/save.js";
import { builtShop, captureIo, readModelFile } from "./helpers.js";

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

const IDS = new Set([
  "mod:targets-cli-src-diff",
  "mod:targets-cli-src-diff-dila",
  "mod:src@database",
  "file:src/db.ts",
  "sym:src/db.ts#prisma",
  "route:GET /health",
  "entity:Order",
  "cap:orders",
  "mod:orders",
]);

describe("repairNodeId", () => {
  it("adds the one kind prefix that names a node", () => {
    expect(repairNodeId("targets-cli-src-diff", IDS)).toBe("mod:targets-cli-src-diff");
    expect(repairNodeId("targets-cli-src-diff-dila", IDS)).toBe("mod:targets-cli-src-diff-dila");
    expect(repairNodeId("src@database", IDS)).toBe("mod:src@database");
    expect(repairNodeId("src/db.ts#prisma", IDS)).toBe("sym:src/db.ts#prisma");
    expect(repairNodeId("GET /health", IDS)).toBe("route:GET /health");
    expect(repairNodeId("Order", IDS)).toBe("entity:Order");
  });

  it("reads a repo-relative path as its file node, a leading ./ dropped", () => {
    expect(repairNodeId("src/db.ts", IDS)).toBe("file:src/db.ts");
    expect(repairNodeId("./src/db.ts", IDS)).toBe("file:src/db.ts");
  });

  it("leaves an ambiguous, unknown or valid id alone, and never guesses", () => {
    // cap:orders and mod:orders both fit.
    expect(repairNodeId("orders", IDS)).toBeUndefined();
    expect(repairNodeId("no-such-module", IDS)).toBeUndefined();
    expect(repairNodeId("mod:orders", IDS)).toBeUndefined();
    // No fuzzy match: another case, a plural, a near slug, a path that is not a file node.
    expect(repairNodeId("order", IDS)).toBeUndefined();
    expect(repairNodeId("Orders", IDS)).toBeUndefined();
    expect(repairNodeId("targets-cli-src", IDS)).toBeUndefined();
    expect(repairNodeId("src/db", IDS)).toBeUndefined();
    expect(repairNodeId(".//src/db.ts", IDS)).toBeUndefined();
    expect(repairNodeId("", IDS)).toBeUndefined();
  });
});

describe("repairAnswerIds", () => {
  it("repairs nodes, edge ends and focus, reports each, and never mutates the input", () => {
    const input = {
      answer: "x",
      nodes: ["targets-cli-src-diff", "entity:Order", "./src/db.ts", "orders"],
      edges: [
        { from: "targets-cli-src-diff", to: "Order", kind: "data" },
        { from: "route:GET /health", to: "nope" },
      ],
      focus: "targets-cli-src-diff-dila",
    };
    const copy = structuredClone(input);
    const { value, repairs } = repairAnswerIds(input, () => IDS);
    expect(value).toEqual({
      answer: "x",
      nodes: ["mod:targets-cli-src-diff", "entity:Order", "file:src/db.ts", "orders"],
      edges: [
        { from: "mod:targets-cli-src-diff", to: "entity:Order", kind: "data" },
        { from: "route:GET /health", to: "nope" },
      ],
      focus: "mod:targets-cli-src-diff-dila",
    });
    expect(repairs).toEqual([
      { path: "nodes[0]", from: "targets-cli-src-diff", to: "mod:targets-cli-src-diff" },
      { path: "nodes[2]", from: "./src/db.ts", to: "file:src/db.ts" },
      { path: "edges[0].from", from: "targets-cli-src-diff", to: "mod:targets-cli-src-diff" },
      { path: "edges[0].to", from: "Order", to: "entity:Order" },
      { path: "focus", from: "targets-cli-src-diff-dila", to: "mod:targets-cli-src-diff-dila" },
    ]);
    expect(input).toEqual(copy);
  });

  it("does not read the view when every id is well-formed, and keeps the input as it is", () => {
    let reads = 0;
    const ids = () => {
      reads++;
      return IDS;
    };
    // entity:Orders names no node, but is a well-formed id: the gates say so, no repair is tried.
    const input = { nodes: ["entity:Order", "entity:Orders"], edges: [{ from: "entity:Order", to: "cap:orders" }], focus: "entity:Order" };
    const r = repairAnswerIds(input, ids);
    expect(r).toEqual({ value: input, repairs: [] });
    expect(r.value).toBe(input);
    expect(reads).toBe(0);
    // Not an answer: left to the schema.
    for (const v of [undefined, null, "nodes", [1], { nodes: "x", edges: [null, "y", { to: 3 }], focus: 4 }])
      expect(repairAnswerIds(v, ids)).toEqual({ value: v, repairs: [] });
    // Nothing repairable: the very input comes back.
    const unknown = { nodes: ["orders", "nope"] };
    expect(repairAnswerIds(unknown, ids).value).toBe(unknown);
    // An edge without an end keeps its shape for the schema to report.
    expect(repairAnswerIds({ nodes: ["Order"], edges: [{ from: "Order" }] }, ids).value).toEqual({
      nodes: ["entity:Order"],
      edges: [{ from: "entity:Order" }],
    });
  });
});

/** The shop lens with the ids written the way an agent reading ultraindex writes them. */
const bareLens = () => ({
  ...readModelFile("shop.lens.json"),
  nodes: ["DELETE /api/orders/:id", "src/services/orders.ts#cancelOrder", "Order", "src-services", "./src/routes/orders.ts"],
  edges: [{ from: "DELETE /api/orders/:id", to: "Order", kind: "data" }],
  focus: "src-services",
});

describe("lens save repairs node ids", () => {
  it("saves a lens whose ids lack their prefix, and reports every repair", async () => {
    const repo = await builtShop(cleanups);
    const r = saveLens(repo, bareLens());
    expect(r.ok).toBe(true);
    expect(r.repairs).toEqual([
      { path: "nodes[0]", from: "DELETE /api/orders/:id", to: "route:DELETE /api/orders/:id" },
      { path: "nodes[1]", from: "src/services/orders.ts#cancelOrder", to: "sym:src/services/orders.ts#cancelOrder" },
      { path: "nodes[2]", from: "Order", to: "entity:Order" },
      { path: "nodes[3]", from: "src-services", to: "mod:src-services" },
      { path: "nodes[4]", from: "./src/routes/orders.ts", to: "file:src/routes/orders.ts" },
      { path: "edges[0].from", from: "DELETE /api/orders/:id", to: "route:DELETE /api/orders/:id" },
      { path: "edges[0].to", from: "Order", to: "entity:Order" },
      { path: "focus", from: "src-services", to: "mod:src-services" },
    ]);
    const saved = JSON.parse(readFileSync(join(repo, r.file!), "utf8"));
    expect(saved.nodes).toEqual([
      "route:DELETE /api/orders/:id",
      "sym:src/services/orders.ts#cancelOrder",
      "entity:Order",
      "mod:src-services",
      "file:src/routes/orders.ts",
    ]);
    expect(saved.focus).toBe("mod:src-services");
    expect(saved.edges).toEqual([{ from: "route:DELETE /api/orders/:id", to: "entity:Order", kind: "data" }]);
  });

  it("repairs nothing in a valid lens, and lets an id it cannot repair fail as before", async () => {
    const repo = await builtShop(cleanups);
    expect(saveLens(repo, readModelFile("shop.lens.json"))).toMatchObject({ ok: true, repairs: [] });
    const r = saveLens(repo, { ...bareLens(), id: "partly", nodes: ["src-services", "no-such-module"], edges: [] });
    expect(r.ok).toBe(false);
    expect(r.repairs).toEqual([
      { path: "nodes[0]", from: "src-services", to: "mod:src-services" },
      { path: "focus", from: "src-services", to: "mod:src-services" },
    ]);
    expect(r.errors).toEqual([{ path: "nodes[1]", message: expect.stringMatching(/"no-such-module" is not a node id/) }]);
  });

  it("prints the repairs, and gives them as `repairs` with --json", async () => {
    const repo = await builtShop(cleanups);
    const file = join(repo, "answer.json");
    writeFileSync(file, JSON.stringify(bareLens()));
    const text = await run(["lens", "save", file, "--repo", repo]);
    expect(text.code).toBe(0);
    expect(text.out).toContain('repaired   8 node id(s):\n  nodes[0]: "DELETE /api/orders/:id" -> "route:DELETE /api/orders/:id"\n');
    expect(text.out).toContain('  focus: "src-services" -> "mod:src-services"\nsaved      .ultraview/lenses/how-cancel-works.json');
    const asJson = await run(["lens", "save", file, "--repo", repo, "--json"]);
    expect(JSON.parse(asJson.out)).toMatchObject({
      ok: true,
      repairs: expect.arrayContaining([{ path: "nodes[3]", from: "src-services", to: "mod:src-services" }]),
    });
    // Refused: the repairs are still said, the errors go to stderr.
    writeFileSync(file, JSON.stringify({ ...bareLens(), nodes: ["src-services", "nope"], edges: [] }));
    const refused = await run(["lens", "save", file, "--repo", repo]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('repaired   2 node id(s):\n  nodes[0]: "src-services" -> "mod:src-services"');
    expect(refused.err).toContain('"nope" is not a node id');
  });
});

describe("lens save --thread repairs node ids", () => {
  const bareTurn = () => {
    const { schema: _s, id: _i, ...lens } = bareLens();
    return { ...lens, lang: "en", mode: "dev", followUps: ["Who calls it?", "What does it store?", "Can it fail?"] };
  };

  it("appends a turn whose ids lack their prefix, repaired against the map", async () => {
    const repo = await builtShop(cleanups);
    chatNew(repo, { id: "orders" });
    const r = saveTurn(repo, JSON.stringify(bareTurn()), { thread: "orders" });
    expect(r.ok).toBe(true);
    expect(r.repairs).toHaveLength(8);
    expect(r.repairs[3]).toEqual({ path: "nodes[3]", from: "src-services", to: "mod:src-services" });
    const turn = loadConversation(repo, "orders").turns[0]!;
    expect(turn.answer.nodes).toContain("mod:src-services");
    expect(turn.answer.focus).toBe("mod:src-services");
    expect(turn.answer.edges).toEqual([{ from: "route:DELETE /api/orders/:id", to: "entity:Order", kind: "data" }]);
    // A valid turn: nothing repaired.
    const valid = { ...bareTurn(), nodes: ["entity:Order"], edges: [], focus: "entity:Order" };
    expect(saveTurn(repo, JSON.stringify(valid), { thread: "orders" })).toMatchObject({ ok: true, repairs: [] });
  });

  it("prints the repairs from the terminal, and refuses an id it cannot repair", async () => {
    const repo = await builtShop(cleanups);
    chatNew(repo, { id: "orders" });
    const file = join(repo, ".ultraview/conversations/orders.draft.json");
    writeFileSync(file, JSON.stringify(bareTurn()));
    const ok = await run(["lens", "save", file, "--thread", "orders", "--repo", repo]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('repaired   8 node id(s):\n  nodes[0]: "DELETE /api/orders/:id" -> "route:DELETE /api/orders/:id"');
    expect(ok.out).toContain("saved      turn 1 of .ultraview/conversations/orders.json");
    // Ambiguity and unknown slugs still fail: nothing appended.
    writeFileSync(file, JSON.stringify({ ...bareTurn(), nodes: ["src-services", "targets-cli-src-diff"], edges: [] }));
    const bad = await run(["lens", "save", file, "--thread", "orders", "--repo", repo, "--json"]);
    expect(bad.code).toBe(1);
    const r = JSON.parse(bad.out);
    expect(r.repairs).toEqual([
      { path: "nodes[0]", from: "src-services", to: "mod:src-services" },
      { path: "focus", from: "src-services", to: "mod:src-services" },
    ]);
    expect(r.errors.map((e: { message: string }) => e.message).join("\n")).toContain('"targets-cli-src-diff" is not a node id');
    expect(loadConversation(repo, "orders").turns).toHaveLength(1);
  });
});
