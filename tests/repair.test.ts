// The repair made before a lens's or a turn's gates (src/gates.ts
// `repairAnswer`: node ids, then edges), through `lens save`, `lens save
// --thread` and saveTurn.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatNew, loadConversation, saveTurn } from "../src/chat.js";
import { main } from "../src/cli.js";
import { EDGE_KIND_SYNONYMS, edgeRule, repairAnswer, repairEdgeKind, repairHeading, repairLines, repairNodeId } from "../src/gates.js";
import { EDGE_KINDS } from "../src/model/types.js";
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

describe("repairAnswer", () => {
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
    const { value, repairs } = repairAnswer(input, () => IDS);
    expect(value).toEqual({
      answer: "x",
      nodes: ["mod:targets-cli-src-diff", "entity:Order", "file:src/db.ts", "orders"],
      edges: [{ from: "mod:targets-cli-src-diff", to: "entity:Order", kind: "data" }],
      focus: "mod:targets-cli-src-diff-dila",
    });
    expect(repairs).toEqual([
      { path: "nodes[0]", from: "targets-cli-src-diff", to: "mod:targets-cli-src-diff" },
      { path: "nodes[2]", from: "./src/db.ts", to: "file:src/db.ts" },
      { path: "edges[0].from", from: "targets-cli-src-diff", to: "mod:targets-cli-src-diff" },
      { path: "edges[0].to", from: "Order", to: "entity:Order" },
      // An edge end no repair resolves: the edge goes, the answer stays.
      { path: "edges[1]", from: { from: "route:GET /health", to: "nope" }, dropped: '"to" "nope" is not a node id' },
      { path: "focus", from: "targets-cli-src-diff-dila", to: "mod:targets-cli-src-diff-dila" },
    ]);
    expect(input).toEqual(copy);
  });

  it("does not read the view when every id is well-formed and there is no edge, and keeps the input as it is", () => {
    let reads = 0;
    const ids = () => {
      reads++;
      return IDS;
    };
    // entity:Orders names no node, but is a well-formed id: the gates say so, no repair is tried.
    const input = { nodes: ["entity:Order", "entity:Orders"], edges: [], focus: "entity:Order" };
    const r = repairAnswer(input, ids);
    expect(r).toEqual({ value: input, repairs: [] });
    expect(r.value).toBe(input);
    expect(reads).toBe(0);
    // Valid edges: the view is read once to check their ends, and nothing changes.
    const valid = {
      ...input,
      edges: [
        { from: "entity:Order", to: "cap:orders" },
        { from: "file:src/db.ts", to: "entity:Order", kind: "data" },
      ],
    };
    const v = repairAnswer(valid, ids);
    expect(v).toEqual({ value: valid, repairs: [] });
    expect(v.value).toBe(valid);
    expect(reads).toBe(1);
    // Not an answer: left to the schema, which still refuses its required fields.
    for (const x of [undefined, null, "nodes", [1], { nodes: "x", edges: "y", focus: 4 }]) expect(repairAnswer(x, ids)).toEqual({ value: x, repairs: [] });
    // Nothing repairable: the very input comes back.
    const unknown = { nodes: ["orders", "nope"] };
    expect(repairAnswer(unknown, ids).value).toBe(unknown);
  });
});

describe("repairEdgeKind", () => {
  it("keeps an edge kind, in any case, and rewrites a synonym of exactly one", () => {
    for (const k of EDGE_KINDS) {
      expect(repairEdgeKind(k)).toBe(k);
      expect(repairEdgeKind(k.toUpperCase())).toBe(k);
    }
    expect(repairEdgeKind("calls")).toBe("call");
    expect(repairEdgeKind("Invokes")).toBe("call");
    expect(repairEdgeKind("imports")).toBe("import");
    expect(repairEdgeKind("reads")).toBe("data");
    expect(repairEdgeKind(" Reads From ")).toBe("data");
    expect(repairEdgeKind("writes_to")).toBe("data");
    expect(repairEdgeKind("stores")).toBe("data");
    expect(repairEdgeKind("fetch")).toBe("http");
    expect(repairEdgeKind("request")).toBe("http");
    expect(repairEdgeKind("tRPC")).toBe("rpc");
    expect(repairEdgeKind("emits")).toBe("event");
    expect(repairEdgeKind("subscribes")).toBe("event");
    expect(repairEdgeKind("enqueue")).toBe("queue");
    expect(repairEdgeKind("inherits")).toBe("extends");
    expect(repairEdgeKind("implements")).toBe("extends");
    expect(repairEdgeKind("configures")).toBe("config");
    expect(repairEdgeKind("includes")).toBe("contains");
  });

  it("guesses nothing for a word that could mean several kinds, or none", () => {
    for (const w of [
      "uses",
      "depends-on",
      "api",
      "triggers",
      "sends",
      "dispatches",
      "query",
      "requires",
      "has",
      "schedules",
      "related",
      "flows",
      "",
      "toString",
      "__proto__",
    ])
      expect(repairEdgeKind(w)).toBeUndefined();
  });

  it("maps every synonym onto an edge kind, never onto another synonym", () => {
    for (const [word, kind] of Object.entries(EDGE_KIND_SYNONYMS)) {
      expect(EDGE_KINDS).toContain(kind);
      expect(word).toBe(word.toLowerCase());
      expect(EDGE_KINDS as readonly string[]).not.toContain(word);
    }
  });
});

describe("repairAnswer on edges", () => {
  // The refused reply that opened issue #29: a `label` on each edge, kinds `calls` and `reads`.
  const observed = () => ({
    answer: "x",
    nodes: ["entity:Order"],
    edges: [
      { from: "file:src/db.ts", to: "sym:src/db.ts#prisma", kind: "calls", label: "creates the client" },
      { from: "sym:src/db.ts#prisma", to: "entity:Order", kind: "reads", label: "reads orders" },
    ],
  });

  it("drops an edge's extra keys and rewrites its kind, reporting each, without mutating the input", () => {
    const input = observed();
    const copy = structuredClone(input);
    const { value, repairs } = repairAnswer(input, () => IDS);
    expect(value).toEqual({
      answer: "x",
      nodes: ["entity:Order"],
      edges: [
        { from: "file:src/db.ts", to: "sym:src/db.ts#prisma", kind: "call" },
        { from: "sym:src/db.ts#prisma", to: "entity:Order", kind: "data" },
      ],
    });
    expect(repairs).toEqual([
      { path: "edges[0].label", from: "creates the client", dropped: "not an edge key (an edge holds from, to, kind)" },
      { path: "edges[0].kind", from: "calls", to: "call" },
      { path: "edges[1].label", from: "reads orders", dropped: "not an edge key (an edge holds from, to, kind)" },
      { path: "edges[1].kind", from: "reads", to: "data" },
    ]);
    expect(input).toEqual(copy);
    expect(repairHeading(repairs)).toBe("repaired 2 edge kind(s); dropped 2 edge key(s)");
    expect(repairLines(repairs)).toEqual([
      '  edges[0].label: dropped "creates the client" (not an edge key (an edge holds from, to, kind))',
      '  edges[0].kind: "calls" -> "call"',
      '  edges[1].label: dropped "reads orders" (not an edge key (an edge holds from, to, kind))',
      '  edges[1].kind: "reads" -> "data"',
    ]);
  });

  it("drops an edge whose kind cannot be repaired, or whose end is missing, malformed or unknown, and keeps the rest", () => {
    const keep = { from: "entity:Order", to: "cap:orders" };
    const input = {
      answer: "x",
      nodes: ["entity:Order"],
      edges: [
        { from: "file:src/db.ts", to: "entity:Order", kind: "uses" },
        keep,
        { from: "entity:Order" },
        { from: "entity:Order", to: "entity:Nope" },
        { from: "Order", to: "orders", kind: 3 },
        "entity:Order -> cap:orders",
        null,
      ],
    };
    const { value, repairs } = repairAnswer(input, () => IDS);
    expect(value).toEqual({ answer: "x", nodes: ["entity:Order"], edges: [keep] });
    expect(repairs).toEqual([
      { path: "edges[0]", from: input.edges[0], dropped: expect.stringContaining('kind "uses" is not an edge kind (import, call, http, rpc,') },
      { path: "edges[2]", from: input.edges[2], dropped: 'no "to"' },
      { path: "edges[3]", from: input.edges[3], dropped: '"to" "entity:Nope" names no node of the map' },
      // Its `from` repairs (Order → entity:Order) but `orders` is ambiguous and 3 no kind: dropped once, as written.
      { path: "edges[4]", from: input.edges[4], dropped: expect.stringMatching(/^"to" "orders" is not a node id; kind 3 is not an edge kind/) },
      { path: "edges[5]", from: "entity:Order -> cap:orders", dropped: 'an edge is an object {"from", "to", "kind"} (got string)' },
      { path: "edges[6]", from: null, dropped: 'an edge is an object {"from", "to", "kind"} (got null)' },
    ]);
    expect(repairHeading(repairs, true)).toBe("dropped    6 edge(s)");
    expect(repairLines(repairs)[1]).toBe('  edges[2]: dropped {"from":"entity:Order"} (no "to")');
  });

  it("checks an edge's ends for form only when there is no map", () => {
    const input = {
      nodes: ["entity:Order"],
      edges: [
        { from: "entity:Order", to: "entity:Nope" },
        { from: "entity:Order", to: "Nope" },
      ],
    };
    const { value, repairs } = repairAnswer(input, () => new Set());
    expect(value).toEqual({ nodes: ["entity:Order"], edges: [{ from: "entity:Order", to: "entity:Nope" }] });
    expect(repairs).toEqual([{ path: "edges[1]", from: { from: "entity:Order", to: "Nope" }, dropped: '"to" "Nope" is not a node id' }]);
  });

  it("names the repairs by what they touched", () => {
    expect(repairHeading([{ path: "nodes[0]", from: "a", to: "mod:a" }], true)).toBe("repaired   1 node id(s)");
    expect(
      repairHeading([
        { path: "nodes[0]", from: "a", to: "mod:a" },
        { path: "edges[0].kind", from: "calls", to: "call" },
        { path: "edges[1]", from: {}, dropped: "x" },
      ]),
    ).toBe("repaired 1 node id(s), 1 edge kind(s); dropped 1 edge(s)");
  });
});

describe("edgeRule", () => {
  it("states the edge shape, the kinds around the candidates with their meaning, the others by name, and one real example", () => {
    const lines = edgeRule([
      { from: "cap:a", to: "cap:b", kind: "call" },
      { from: "file:src/db.ts", to: "entity:Order", kind: "data" },
    ]);
    expect(lines[0]).toBe(
      'Each edge is exactly {"from": "<node id>", "to": "<node id>", "kind": "<edge kind>"}: kind optional, no other key (no label); edges may be [].',
    );
    expect(lines[1]).toBe(
      "Edge kinds around these candidates: call (code calls a function, a method or an SDK); data (code reads or writes an entity, or an entity relates to another). The other edge kinds: import, http, rpc, event, queue, extends, config, contains.",
    );
    expect(lines[2]).toBe('e.g. {"from": "file:src/db.ts", "to": "entity:Order", "kind": "data"}');
    expect(lines[3]).toContain("an edge with another kind, or an end that is not a node of the map, is dropped");
    // No edges around the pack: every kind with its meaning, no example.
    const all = edgeRule();
    expect(all).toHaveLength(3);
    for (const k of EDGE_KINDS) expect(all[1]).toContain(`${k} (`);
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

describe("lens save repairs or drops bad edges", () => {
  /** The shop lens with edges the way issue #29 saw them. */
  const labelled = () => ({
    ...readModelFile("shop.lens.json"),
    edges: [
      { from: "route:DELETE /api/orders/:id", to: "sym:src/services/orders.ts#cancelOrder", kind: "Calls", label: "hands the id over" },
      { from: "sym:src/services/orders.ts#cancelOrder", to: "entity:Order", kind: "reads" },
      { from: "sym:src/services/orders.ts#cancelOrder", to: "entity:Nope", kind: "data" },
    ],
  });
  const kept = [
    { from: "route:DELETE /api/orders/:id", to: "sym:src/services/orders.ts#cancelOrder", kind: "call" },
    { from: "sym:src/services/orders.ts#cancelOrder", to: "entity:Order", kind: "data" },
  ];

  it("saves the lens with its edges repaired, the rest dropped, and says so in text and in --json", async () => {
    const repo = await builtShop(cleanups);
    // Under .ultraview/, so the index stays fresh for `check` below.
    const file = join(repo, ".ultraview/answer.json");
    writeFileSync(file, JSON.stringify(labelled()));
    const text = await run(["lens", "save", file, "--repo", repo]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(
      'repaired   2 edge kind(s); dropped 1 edge key(s), 1 edge(s):\n  edges[0].label: dropped "hands the id over" (not an edge key (an edge holds from, to, kind))\n  edges[0].kind: "Calls" -> "call"\n  edges[1].kind: "reads" -> "data"\n  edges[2]: dropped {"from":"sym:src/services/orders.ts#cancelOrder","to":"entity:Nope","kind":"data"} ("to" "entity:Nope" names no node of the map)\nsaved      .ultraview/lenses/how-cancel-works.json',
    );
    expect(JSON.parse(readFileSync(join(repo, ".ultraview/lenses/how-cancel-works.json"), "utf8")).edges).toEqual(kept);
    const asJson = JSON.parse((await run(["lens", "save", file, "--repo", repo, "--json"])).out);
    expect(asJson).toMatchObject({ ok: true });
    expect(asJson.repairs).toEqual([
      { path: "edges[0].label", from: "hands the id over", dropped: "not an edge key (an edge holds from, to, kind)" },
      { path: "edges[0].kind", from: "Calls", to: "call" },
      { path: "edges[1].kind", from: "reads", to: "data" },
      { path: "edges[2]", from: labelled().edges[2], dropped: '"to" "entity:Nope" names no node of the map' },
    ]);
    // What was saved passes `check` too.
    expect((await run(["check", "--repo", repo])).code).toBe(0);
  });

  it("still refuses an answer whose required fields are invalid, saying what was dropped", async () => {
    const repo = await builtShop(cleanups);
    const r = saveLens(repo, { ...labelled(), answer: "" });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ path: "answer", message: "must not be empty" }]);
    expect(r.repairs).toHaveLength(4);
    expect(saveLens(repo, { ...labelled(), nodes: "entity:Order" })).toMatchObject({ ok: false, errors: [{ path: "nodes" }] });
  });

  it("appends a turn with its edges repaired", async () => {
    const repo = await builtShop(cleanups);
    chatNew(repo, { id: "orders" });
    const { schema: _s, id: _i, ...lens } = labelled();
    const turn = { ...lens, lang: "en", mode: "dev", followUps: ["Who calls it?", "What does it store?", "Can it fail?"] };
    const r = saveTurn(repo, JSON.stringify(turn), { thread: "orders" });
    expect(r.ok).toBe(true);
    expect(r.repairs.map((x) => x.path)).toEqual(["edges[0].label", "edges[0].kind", "edges[1].kind", "edges[2]"]);
    expect(loadConversation(repo, "orders").turns[0]!.answer.edges).toEqual(kept);
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
