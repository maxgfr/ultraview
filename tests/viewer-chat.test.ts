// The chat panel's pure logic (viewer/lib/chat.ts): the thread reducer fed by
// the `POST /api/chat` event stream and `POST /api/explain`, the stream reader,
// contexts ("Ask about this"), citations → nodes, `#chat=` keep / restore and
// reading untrusted conversations. Runs in node: nothing here touches the DOM.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewModel } from "../src/model/types.js";
import { normalizeInsights } from "../viewer/lib/changes.js";
import {
  answerIds,
  type ChatAction,
  type ChatState,
  chatEntries,
  chatFromRoute,
  chatMode,
  chatReducer,
  chatRunning,
  citeNode,
  contextable,
  contextLabel,
  edgeContext,
  initialChat,
  insightContext,
  listOf,
  nodeContext,
  nodesByPath,
  progressLine,
  readChatFrame,
  readChatList,
  readConversation,
  readConversations,
  readExplain,
  readTurn,
  routeChat,
  sseReader,
  stepContext,
  type ViewTurn,
} from "../viewer/lib/chat.js";
import { buildIndex } from "../viewer/lib/data.js";
import { setLang } from "../viewer/lib/i18n.js";
import { citeAt } from "../viewer/lib/markdown.js";
import { formatHash, parseHash } from "../viewer/lib/route.js";

const view = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/shop.view.json"), "utf8")) as ViewModel;
const ix = buildIndex(view);
const insights = normalizeInsights(view.insights);

afterEach(() => setLang("en"));

const turn = (question: string, more: Partial<ViewTurn> = {}): ViewTurn => ({
  question,
  lang: "en",
  mode: "dev",
  source: "agent",
  answer: { answer: `${question} [src/db.ts:3]`, nodes: ["sym:src/db.ts#prisma"] },
  followUps: ["a?", "b?", "c?"],
  at: "2026-01-01T00:00:00.000Z",
  ...more,
});
const run = (actions: ChatAction[], from: ChatState = initialChat) => actions.reduce(chatReducer, from);
const order = (s: ChatState) => chatEntries(s).map((e) => (e.type === "saved" ? `saved:${e.turn.question}` : `${e.entry.status}:${e.entry.question}`));

describe("chat thread", () => {
  it("a run: pending with progress, then the saved turn takes its place", () => {
    let s = run([
      { type: "open", thread: "t1" },
      { type: "loaded", conversation: { id: "t1", title: "T", createdAt: "", turns: [turn("one")] } },
      { type: "send", key: "k1", question: "two", mode: "dev" },
    ]);
    expect(chatRunning(s)).toBe(true);
    expect(s.local[0]).toMatchObject({ after: 1, status: "pending", thread: "t1" });
    s = chatReducer(s, { type: "progress", key: "k1", text: "claude started" });
    expect(s.local[0]!.progress).toBe("claude started");
    expect(order(s)).toEqual(["saved:one", "pending:two"]);
    s = chatReducer(s, { type: "turn", key: "k1", thread: "t1", index: 1, turn: turn("two") });
    expect(chatRunning(s)).toBe(false);
    expect(order(s)).toEqual(["saved:one", "saved:two"]);
    expect(s.behind).toBeUndefined();
  });

  it("a first turn names a new conversation; a turn past the saved ones asks for a re-read", () => {
    let s = run([{ type: "send", key: "k1", question: "How does it work?", mode: "business" }]);
    expect(s.thread).toBeUndefined();
    s = chatReducer(s, { type: "turn", key: "k1", thread: "how-does-it-work", index: 0, turn: turn("How does it work?") });
    expect(s).toMatchObject({ thread: "how-does-it-work", title: "How does it work?" });
    // Turns 2 and 3 were saved from the terminal meanwhile: index 3 cannot be placed yet.
    s = run(
      [
        { type: "send", key: "k2", question: "next", mode: "dev" },
        { type: "turn", key: "k2", thread: "how-does-it-work", index: 3, turn: turn("next") },
      ],
      s,
    );
    expect(s.behind).toBe(true);
    expect(s.saved).toHaveLength(1);
    s = chatReducer(s, {
      type: "loaded",
      conversation: {
        id: "how-does-it-work",
        title: "How does it work?",
        createdAt: "",
        turns: [turn("How does it work?"), turn("x"), turn("y"), turn("next")],
      },
    });
    expect(s.behind).toBeUndefined();
    expect(order(s)).toEqual(["saved:How does it work?", "saved:x", "saved:y", "saved:next"]);
  });

  it("a turn that lands after the user moved to another conversation changes nothing there", () => {
    let s = run([
      { type: "open", thread: "a" },
      { type: "send", key: "k1", question: "q", mode: "dev" },
      { type: "open", thread: "b" },
    ]);
    expect(s.local).toEqual([]);
    s = chatReducer(s, { type: "turn", key: "k1", thread: "a", index: 0, turn: turn("q") });
    expect(s).toMatchObject({ thread: "b", saved: [] });
    // Nor does one of another page's new conversation.
    const fresh = chatReducer(initialChat, { type: "turn", key: "nope", thread: "other", index: 0, turn: turn("q") });
    expect(fresh.thread).toBeUndefined();
  });

  it("an instant answer sits in the thread; escalating it marks it and keeps it before the agent's turn", () => {
    const ctx = nodeContext("route:DELETE /api/orders/:id");
    let s = run([
      { type: "draft", context: ctx },
      { type: "explain", key: "f1", question: "What is DELETE /api/orders/:id?", context: ctx, mode: "business" },
    ]);
    expect(order(s)).toEqual(["explaining:What is DELETE /api/orders/:id?"]);
    s = chatReducer(s, { type: "explained", key: "f1", facts: { answer: { answer: "x [a.ts:1]", nodes: [] }, escalate: true } });
    expect(s.local[0]).toMatchObject({ status: "facts", facts: { escalate: true } });
    s = chatReducer(s, { type: "send", key: "k1", question: "What is DELETE /api/orders/:id?", context: { ...ctx }, mode: "business", from: "f1" });
    // The question took the composer's context with it.
    expect(s.draft).toBeUndefined();
    expect(s.local[0]!.escalated).toBe(true);
    s = chatReducer(s, { type: "turn", key: "k1", thread: "what-is", index: 0, turn: turn("What is DELETE /api/orders/:id?") });
    expect(order(s)).toEqual(["facts:What is DELETE /api/orders/:id?", "saved:What is DELETE /api/orders/:id?"]);
  });

  it("a follow-up leaves the composer's context; failures show inline and can be dismissed", () => {
    let s = run([
      { type: "draft", context: insightContext("cycle:x") },
      { type: "send", key: "k1", question: "Who calls it?", mode: "dev" },
    ]);
    expect(s.draft).toEqual({ insight: "cycle:x" });
    s = chatReducer(s, { type: "failed", key: "k1", error: "an ask is already running" });
    expect(s.local[0]).toMatchObject({ status: "error", error: "an ask is already running" });
    expect(s.local[0]!.explain).toBeUndefined();
    s = run(
      [
        { type: "explain", key: "f1", question: "q", context: nodeContext("x"), mode: "dev" },
        { type: "failed", key: "f1", error: "unknown node id: x" },
      ],
      s,
    );
    expect(s.local[1]).toMatchObject({ status: "error", explain: true });
    s = chatReducer(s, { type: "dismiss", key: "k1" });
    expect(s.local.map((e) => e.key)).toEqual(["f1"]);
    // An empty context clears it.
    expect(chatReducer(s, { type: "draft", context: {} }).draft).toBeUndefined();
  });

  it("opening: the same conversation is a no-op, another resets, a new one keeps the draft and the list", () => {
    const base = run([
      { type: "open", thread: "a" },
      { type: "list", items: [{ id: "a", title: "A", turns: 1, updatedAt: "" }] },
      { type: "draft", context: nodeContext("entity:Order") },
    ]);
    expect(chatReducer(base, { type: "open", thread: "a" })).toBe(base);
    expect(chatReducer(base, { type: "open", thread: "b" })).toEqual({ thread: "b", saved: [], local: [], loading: true, list: base.list });
    expect(chatReducer(base, { type: "open" })).toEqual({ saved: [], local: [], loading: false, list: base.list, draft: { node: "entity:Order" } });
    // A load for another conversation, or a failure of one, is ignored.
    expect(chatReducer(base, { type: "loaded", conversation: { id: "zzz", title: "", createdAt: "", turns: [] } })).toBe(base);
    expect(chatReducer(base, { type: "load-failed", thread: "a", error: "gone" })).toMatchObject({ loading: false, loadError: "gone" });
  });
});

describe("chat stream", () => {
  it("reads Server-Sent Events split anywhere, with comments, CRLF and multi-line data", () => {
    const r = sseReader();
    const text = 'event: progress\r\ndata: {"text":"asking claude"}\r\n\r\n: ping\n\nevent: turn\ndata: {"a":\ndata: 1}\n\nevent: error\ndata:{"message":"x"}';
    const frames = [];
    for (let i = 0; i < text.length; i += 3) frames.push(...r.push(text.slice(i, i + 3)));
    frames.push(...r.end());
    expect(frames).toEqual([
      { event: "progress", data: '{"text":"asking claude"}' },
      { event: "turn", data: '{"a":\n1}' },
      { event: "error", data: '{"message":"x"}' },
    ]);
  });

  it("turns frames into events, refusing junk", () => {
    expect(readChatFrame({ event: "progress", data: '{"text":"claude started"}' })).toEqual({ type: "progress", text: "claude started" });
    expect(readChatFrame({ event: "error", data: '{"message":"did not pass"}' })).toEqual({ type: "error", message: "did not pass" });
    const t = turn("q");
    expect(readChatFrame({ event: "turn", data: JSON.stringify({ thread: "x", index: 0, turn: { ...t, sources: { "a.ts": "h" } } }) })).toEqual({
      type: "turn",
      thread: "x",
      index: 0,
      turn: t,
    });
    expect(readChatFrame({ event: "turn", data: JSON.stringify({ thread: "x", index: -1, turn: t }) })).toBeUndefined();
    expect(readChatFrame({ event: "turn", data: JSON.stringify({ thread: "x", index: 0, turn: { question: "q" } }) })).toBeUndefined();
    expect(readChatFrame({ event: "progress", data: "not json" })).toBeUndefined();
    expect(readChatFrame({ event: "view", data: "{}" })).toBeUndefined();
  });

  it("says the server's progress lines in the interface language", () => {
    expect(progressLine("asking claude (turn 2 of t1)")).toBe("Asking claude…");
    expect(progressLine("codex started")).toBe("codex started…");
    expect(progressLine("claude is reading the code")).toBe("claude is reading the code…");
    expect(progressLine("claude is reading the code (12 KB of output)")).toBe("claude is reading the code (12 KB so far)…");
    expect(progressLine("checking the answer: schema, node ids, citations")).toBe("Checking every citation before saving…");
    expect(progressLine("something new")).toBe("something new");
    setLang("fr");
    expect(progressLine("claude is reading the code (3 KB of output)")).toBe("claude lit le code (3 Ko pour l’instant)…");
  });
});

describe("chat contexts", () => {
  it("formats what /api/chat reads: node, edge, insight, flow step (n from 1)", () => {
    expect(nodeContext("entity:Order")).toEqual({ node: "entity:Order" });
    expect(edgeContext("route:POST /api/orders", "entity:Order")).toEqual({ edge: "route:POST /api/orders -> entity:Order" });
    expect(stepContext("place-order", 0)).toEqual({ step: "place-order:1" });
    expect(insightContext("cycle:src>src-routes>src-services")).toEqual({ insight: "cycle:src>src-routes>src-services" });
    expect(contextable("actor:customer")).toBe(false);
    expect(contextable("entity:Order")).toBe(true);
  });

  it("names what a context points at", () => {
    expect(contextLabel(ix, insights, undefined)).toBeUndefined();
    expect(contextLabel(ix, insights, nodeContext("entity:Order"))).toBe("Order");
    expect(contextLabel(ix, insights, edgeContext("route:DELETE /api/orders/:id", "entity:Order"))).toBe("DELETE /api/orders/:id → Order");
    expect(contextLabel(ix, insights, edgeContext("file:src/routes/orders.ts", "file:src/services/orders.ts"))).toBe(
      "orders.ts · routes → orders.ts · services",
    );
    expect(contextLabel(ix, insights, stepContext("place-order", 1))).toBe(`step 2 of ${view.flows[0]!.title}`);
    expect(contextLabel(ix, insights, insightContext(insights[0]!.id))).toBe(insights[0]!.title);
    // Unknown ids still read as something.
    expect(contextLabel(ix, insights, { node: "entity:Ghost", step: "nope:3" })).toBe("entity:Ghost · step 3 of nope");
  });

  it("the business / developer toggle is the mode", () => {
    expect(chatMode("business")).toBe("business");
    expect(chatMode("developer")).toBe("dev");
  });

  it("lights an answer's focus, nodes and edge ends, each once, known ones only", () => {
    const a = {
      answer: "",
      nodes: ["sym:src/services/orders.ts#cancelOrder", "entity:Order", "entity:Ghost"],
      edges: [{ from: "route:DELETE /api/orders/:id", to: "entity:Order" }],
      focus: "route:DELETE /api/orders/:id",
    };
    expect(answerIds(a, (id) => ix.byId.has(id))).toEqual(["route:DELETE /api/orders/:id", "sym:src/services/orders.ts#cancelOrder", "entity:Order"]);
  });
});

describe("chat citations", () => {
  const byPath = nodesByPath(ix);
  it("opens the node defined at or above the cited line, else the file", () => {
    expect(citeNode(ix, byPath, citeAt("[src/routes/orders.ts:19-21]")!)).toBe("route:DELETE /api/orders/:id");
    expect(citeNode(ix, byPath, citeAt("[src/services/orders.ts:26]")!)).toBe("sym:src/services/orders.ts#cancelOrder");
    expect(citeNode(ix, byPath, citeAt("[src/services/orders.ts:1]")!)).toBe("file:src/services/orders.ts");
    expect(citeNode(ix, byPath, citeAt("[nowhere/x.ts:3]")!)).toBeUndefined();
    expect(citeNode(ix, byPath, citeAt("[src/services/orders.ts]")!)).toBe("file:src/services/orders.ts"); // no line: the file
  });

  it("a node with a span wins, the answer's own nodes break ties", () => {
    const v: ViewModel = {
      ...view,
      nodes: [
        ...view.nodes,
        {
          id: "sym:src/db.ts#a",
          kind: "sym",
          label: "a",
          parent: "file:src/db.ts",
          cites: [],
          at: "src/db.ts:1-10",
          metrics: view.nodes[0]!.metrics,
          caps: [],
          tags: [],
        },
        {
          id: "sym:src/db.ts#b",
          kind: "sym",
          label: "b",
          parent: "file:src/db.ts",
          cites: [],
          at: "src/db.ts:2-4",
          metrics: view.nodes[0]!.metrics,
          caps: [],
          tags: [],
        },
        {
          id: "sym:src/db.ts#c",
          kind: "sym",
          label: "c",
          parent: "file:src/db.ts",
          cites: [],
          at: "src/db.ts:2-4",
          metrics: view.nodes[0]!.metrics,
          caps: [],
          tags: [],
        },
      ],
    };
    const x = buildIndex(v);
    const p = nodesByPath(x);
    expect(citeNode(x, p, { path: "src/db.ts", line: 3 })).toBe("sym:src/db.ts#b");
    expect(citeNode(x, p, { path: "src/db.ts", line: 3 }, ["sym:src/db.ts#c"])).toBe("sym:src/db.ts#c");
    expect(citeNode(x, p, { path: "src/db.ts", line: 8 })).toBe("sym:src/db.ts#a");
  });
});

describe("chat deep link", () => {
  it("#chat= round-trips beside any view", () => {
    for (const hash of ["#chat=how-orders-work", "#view=data&chat=a-1&node=entity:Order", "#flow=place-order&step=2&chat=x"])
      expect(formatHash(parseHash(hash))).toBe(hash);
    expect(parseHash("#chat=how-orders-work")).toEqual({ view: "map", chat: "how-orders-work" });
  });

  it("the hash names the open panel's conversation; closing keeps it for the next open", () => {
    expect(routeChat({ chat: "a", chatOpen: true })).toBe("a");
    expect(routeChat({ chat: "a", chatOpen: false })).toBeUndefined();
    expect(routeChat({ chatOpen: true })).toBeUndefined();
  });

  it("following a link: #chat opens it; back past it closes it; a new unnamed one stays open", () => {
    expect(chatFromRoute("a", { chatOpen: false })).toEqual({ chat: "a", chatOpen: true });
    expect(chatFromRoute("b", { chat: "a", chatOpen: true })).toEqual({ chat: "b", chatOpen: true });
    expect(chatFromRoute(undefined, { chat: "a", chatOpen: true })).toEqual({ chatOpen: false });
    expect(chatFromRoute(undefined, { chatOpen: true })).toEqual({ chatOpen: true });
    expect(chatFromRoute(undefined, { chatOpen: false })).toEqual({ chatOpen: false });
  });
});

describe("chat data", () => {
  it("reads conversations from untrusted JSON, dropping what is not one", () => {
    const good = {
      id: "c1",
      title: "T",
      createdAt: "2026-01-01T00:00:00.000Z",
      turns: [turn("q"), { question: 3 }, { ...turn("r"), mode: "weird", source: "facts", ms: -1 }],
    };
    const c = readConversation(good)!;
    expect(c.turns.map((x) => x.question)).toEqual(["q", "r"]);
    expect(c.turns[1]).toMatchObject({ mode: "business", source: "facts" });
    expect(c.turns[1]!.ms).toBeUndefined();
    expect(readConversation({ id: "", turns: [] })).toBeUndefined();
    expect(readConversations([good, null, "x", { id: "c2", turns: [] }]).map((x) => x.id)).toEqual(["c1", "c2"]);
    expect(readConversations({})).toEqual([]);
    expect(readTurn({ ...turn("q"), context: { node: "entity:Order", color: "red", edge: 3 } })!.context).toEqual({ node: "entity:Order" });
  });

  it("lists conversations newest first, from the server or from the page", () => {
    expect(readChatList([{ id: "a", title: "A", turns: 2, updatedAt: "x" }, { id: 3 }, null])).toEqual([{ id: "a", title: "A", turns: 2, updatedAt: "x" }]);
    const conv = (id: string, at: string, turns: ViewTurn[] = []) => ({ id, title: id, createdAt: at, turns });
    expect(
      listOf([conv("old", "2026-01-01"), conv("new", "2026-01-01", [turn("q", { at: "2026-03-01" })]), conv("mid", "2026-02-01")]).map((c) => c.id),
    ).toEqual(["new", "mid", "old"]);
  });

  it("reads /api/explain's answer as an instant, cited turn focused on the node", () => {
    const x = readExplain(
      {
        node: "entity:Order",
        answer: "Order is a data model. [prisma/schema.prisma:10]",
        nodes: ["entity:Order"],
        edges: [{ from: "entity:Order", to: "entity:OrderItem", kind: "data" }, { from: 1 }],
        escalate: false,
        langFallback: "de",
        source: "facts",
      },
      "entity:Order",
    );
    expect(x).toEqual({
      answer: {
        answer: "Order is a data model. [prisma/schema.prisma:10]",
        nodes: ["entity:Order"],
        edges: [{ from: "entity:Order", to: "entity:OrderItem", kind: "data" }],
        focus: "entity:Order",
      },
      escalate: false,
      langFallback: "de",
    });
    expect(readExplain({ error: "unknown node id" }, "x")).toBeUndefined();
  });
});
