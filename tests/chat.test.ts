import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerSummary,
  CHAT_TURNS_MAX,
  chatDigest,
  chatList,
  chatNew,
  DIGEST_BUDGET,
  DIGEST_TURNS,
  isChatId,
  loadConversation,
  promoteTurn,
  readConversation,
  resolveContext,
  saveTurn,
} from "../src/chat.js";
import { checkMap } from "../src/check.js";
import { main } from "../src/cli.js";
import { lensNew, proposeLensId } from "../src/lens.js";
import { guessLang } from "../src/lens-terms.js";
import type { ChatTurn, Conversation } from "../src/model/types.js";
import { builtShop, captureIo, touch, writeView } from "./helpers.js";

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

const NOW = new Date("2026-02-01T10:00:00.000Z");

/** A turn file as the agent writes it (the template of `lens new --thread`, filled in). */
const placeTurn = () => ({
  question: "How does placing an order work?",
  answer:
    "POST /api/orders hands the request body to placeOrder. [src/routes/orders.ts:10-12]\n\nIt refuses an unknown product, then stores the order with its items. [src/services/orders.ts:14-21]",
  nodes: ["route:POST /api/orders", "sym:src/services/orders.ts#placeOrder", "entity:Order"],
  focus: "route:POST /api/orders",
  lang: "en",
  mode: "dev",
  followUps: ["What data does it write?", "Who calls placeOrder?", "How is an order cancelled?"],
});

/** A stored turn, for conversations written by hand. */
const storedTurn = (over: Partial<ChatTurn> = {}): ChatTurn => ({
  question: "Where is the database client created?",
  lang: "en",
  mode: "business",
  source: "agent",
  answer: { answer: "The client is created once and shared. [src/db.ts:3]", nodes: ["sym:src/db.ts#prisma"] },
  followUps: ["a?", "b?", "c?"],
  sources: {},
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("conversation store", () => {
  it("creates a thread, appends validated turns, and reads them back byte-stable", async () => {
    const repo = await builtShop(cleanups);
    const c = chatNew(repo, { now: NOW });
    expect(c).toEqual({ id: "conversation", title: "Conversation", createdAt: NOW.toISOString(), turns: [] });
    expect(chatNew(repo, { title: "Orders, end to end", now: NOW }).id).toBe("orders-end-to-end");
    expect(chatNew(repo, { title: "Orders, end to end", now: NOW }).id).toBe("orders-end-to-end-2");

    const r = saveTurn(repo, JSON.stringify(placeTurn()), { thread: "conversation", now: NOW, ms: 1234.4 });
    expect(r).toMatchObject({ ok: true, thread: "conversation", file: ".ultraview/conversations/conversation.json", index: 0, created: false, errors: [] });
    const saved = loadConversation(repo, "conversation");
    // The first turn names a thread that still has the default title.
    expect(saved.title).toBe("How does placing an order work?");
    expect(saved.turns[0]).toEqual({
      question: "How does placing an order work?",
      lang: "en",
      mode: "dev",
      source: "agent",
      answer: { answer: placeTurn().answer, nodes: placeTurn().nodes, focus: "route:POST /api/orders" },
      followUps: placeTurn().followUps,
      sources: { "src/routes/orders.ts": expect.stringMatching(/^[0-9a-f]{64}$/), "src/services/orders.ts": expect.stringMatching(/^[0-9a-f]{64}$/) },
      at: NOW.toISOString(),
      ms: 1234,
    });
    const file = join(repo, ".ultraview/conversations/conversation.json");
    const bytes = readFileSync(file, "utf8");
    expect(bytes.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(bytes))).toEqual(["createdAt", "id", "title", "turns"]);

    // The second turn keeps the thread's mode when the file names none, and guesses the language.
    const second = { ...placeTurn(), question: "Et qui l'appelle ?", lang: undefined, mode: undefined };
    const r2 = saveTurn(repo, second, { thread: "conversation", now: NOW });
    expect(r2).toMatchObject({ ok: true, index: 1 });
    expect(loadConversation(repo, "conversation").turns[1]).toMatchObject({ lang: "fr", mode: "dev" });

    // A first turn without a thread creates one named after its question.
    const r3 = saveTurn(repo, placeTurn(), { now: NOW });
    expect(r3).toMatchObject({ ok: true, created: true, thread: "how-does-placing-an-order-work", index: 0 });
    expect(chatList(repo).conversations.map((x) => [x.id, x.turns])).toEqual([
      ["conversation", 2],
      ["how-does-placing-an-order-work", 1],
      ["orders-end-to-end", 0],
      ["orders-end-to-end-2", 0],
    ]);
    expect(checkMap(repo).errors).toEqual([]);
  });

  it("refuses a turn that fails a lens's gates or the turn's own, and writes nothing", async () => {
    const repo = await builtShop(cleanups);
    chatNew(repo, { title: "t", now: NOW });
    const before = readFileSync(join(repo, ".ultraview/conversations/t.json"), "utf8");
    const bad = {
      ...placeTurn(),
      answer: "POST /api/orders hands the body to placeOrder. [src/routes/orders.ts:10-12] It also emails a receipt. And cites a dead line. [src/db.ts:99]",
      nodes: ["route:POST /api/orders", "entity:Nope"],
      lang: "english",
      mode: "manager",
      followUps: ["only one"],
      context: { node: "entity:Ghost" },
      extra: true,
    };
    const r = saveTurn(repo, bad, { thread: "t" });
    expect(r.ok).toBe(false);
    const msgs = r.errors.map((e) => `${e.path}: ${e.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^extra: unknown key "extra"/),
        expect.stringMatching(/^answer: dead citation \[src\/db\.ts:99\]/),
        "followUps: exactly 3 follow-up questions, in the question's language (got 1)",
        'lang: "english" is not a language tag (en, fr, pt-BR…)',
        "mode: must be one of business, dev",
        "context: context.node: unknown node: entity:Ghost",
      ]),
    );
    expect(readFileSync(join(repo, ".ultraview/conversations/t.json"), "utf8")).toBe(before);

    // Past the schema and citations, check's gates: node ids and every sentence cited.
    const r2 = saveTurn(
      repo,
      {
        ...placeTurn(),
        answer: "POST /api/orders hands the body to placeOrder. [src/routes/orders.ts:10-12] It also emails a receipt.",
        nodes: ["entity:Nope"],
      },
      { thread: "t" },
    );
    expect(r2.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      expect.stringMatching(/^nodes\[0\]: unknown node "entity:Nope"/),
      'answer: uncited sentence: "It also emails a receipt."',
    ]);
    // Not JSON, or not an object.
    expect(saveTurn(repo, "{nope", { thread: "t" }).errors[0]!.message).toMatch(/JSON/);
    expect(saveTurn(repo, [1], { thread: "t" }).errors[0]!.message).toBe("must be an object");
    expect(() => saveTurn(repo, placeTurn(), { thread: "missing" })).toThrow(/unknown conversation: missing/);
    // A facts turn may carry no follow-ups; an agent turn may not.
    expect(saveTurn(repo, { ...placeTurn(), followUps: [] }, { thread: "t", source: "facts" }).ok).toBe(true);
  });

  it("bounds a thread's length and its questions", async () => {
    const repo = await builtShop(cleanups);
    const full: Conversation = { id: "full", title: "Full", createdAt: NOW.toISOString(), turns: Array.from({ length: CHAT_TURNS_MAX }, () => storedTurn()) };
    writeView(repo, "conversations/full.json", full);
    expect(saveTurn(repo, placeTurn(), { thread: "full" }).errors.map((e) => e.message)).toContain(
      `the conversation already holds ${CHAT_TURNS_MAX} turns: start a new one (\`ultraview chat new\`)`,
    );
    chatNew(repo, { title: "t" });
    expect(saveTurn(repo, { ...placeTurn(), question: "x".repeat(501) }, { thread: "t" }).errors.map((e) => e.path)).toContain("question");
  });

  it("never leaves its directory: ids are slugs", async () => {
    const repo = await builtShop(cleanups);
    for (const bad of ["../model", "a/b", "..", "A", "", "x".repeat(65), "a.json"]) expect(isChatId(bad)).toBe(false);
    expect(isChatId("orders-2")).toBe(true);
    expect(() => readConversation(repo, "../model")).toThrow(/not a conversation id/);
    expect(() => saveTurn(repo, placeTurn(), { thread: "../lenses/x" })).toThrow(/not a conversation id/);
    expect(() => lensNew(repo, "and then?", { thread: "../../etc" })).toThrow(/not a conversation id/);
    const show = await run(["chat", "show", "../model", "--repo", repo]);
    expect(show.code).toBe(1);
    expect(show.err).toContain("not a conversation id");
    const save = await run(["lens", "save", join(repo, "README.md"), "--thread", "../x", "--repo", repo]);
    expect(save.code).toBe(1);
    expect(existsSync(join(repo, ".ultraview/x.json"))).toBe(false);
  });
});

describe("the digest", () => {
  it("lists questions, one-line answers, node ids and what was clicked, most recent last", async () => {
    const c: Conversation = {
      id: "orders",
      title: "Orders",
      createdAt: NOW.toISOString(),
      turns: [
        storedTurn({ context: { node: "sym:src/db.ts#prisma" } }),
        storedTurn({
          question: "And who uses it?",
          answer: {
            answer: "**Three** functions read it. [src/services/orders.ts:1] They live in the services. [src/services/orders.ts:8]",
            nodes: ["sym:src/services/orders.ts#listOrders", "sym:src/services/orders.ts#placeOrder"],
          },
        }),
      ],
    };
    expect(answerSummary("**Three** functions read it. [src/services/orders.ts:1] They live in the services.")).toBe("Three functions read it.");
    expect(chatDigest(c)).toBe(
      [
        "## Conversation so far (thread orders: 2 turn(s); most recent last)",
        '1. [en, business] "Where is the database client created?"',
        "   answer: The client is created once and shared.",
        "   nodes: sym:src/db.ts#prisma",
        "   asked about: node sym:src/db.ts#prisma",
        '2. [en, business] "And who uses it?"',
        "   answer: Three functions read it.",
        "   nodes: sym:src/services/orders.ts#listOrders, sym:src/services/orders.ts#placeOrder",
        "In play (most recent first): sym:src/services/orders.ts#listOrders, sym:src/services/orders.ts#placeOrder, sym:src/db.ts#prisma",
      ].join("\n"),
    );
    expect(chatDigest({ ...c, turns: [] })).toBe("");
  });

  it("stays within its budget however long the thread", () => {
    const long = "word ".repeat(300);
    const c: Conversation = {
      id: "long",
      title: "Long",
      createdAt: NOW.toISOString(),
      turns: Array.from({ length: CHAT_TURNS_MAX }, (_, i) =>
        storedTurn({
          question: `Question ${i} ${long}`,
          answer: { answer: `Answer ${i} ${long}. [src/db.ts:3]`, nodes: Array.from({ length: 20 }, (_, j) => `entity:E${i}x${j}`) },
        }),
      ),
    };
    const d = chatDigest(c);
    expect(d.length).toBeLessThanOrEqual(DIGEST_BUDGET * 4);
    expect(d).toContain(`thread long: ${CHAT_TURNS_MAX} turn(s), the`);
    expect(d).toContain("oldest left out");
    expect(d).toContain(`${CHAT_TURNS_MAX}. [en, business] "Question ${CHAT_TURNS_MAX - 1}`);
    expect(d).not.toContain(`${CHAT_TURNS_MAX - DIGEST_TURNS}. [en`);
    expect(d).toContain("(+12)");
    expect(chatDigest(c, 100).length).toBeLessThanOrEqual(400);
  });
});

describe("lens new --thread", () => {
  it("ranks the previous turn's nodes and their neighbours for a follow-up with no content words", async () => {
    const repo = await builtShop(cleanups, { model: false });
    writeView(repo, "conversations/db.json", { id: "db", title: "DB", createdAt: NOW.toISOString(), turns: [storedTurn()] });
    const q = "got it, and which parts of the code use it?";
    const top = (ids: string[]) => ids.slice(0, 10);
    const users = ["sym:src/services/orders.ts#listOrders", "sym:src/services/orders.ts#placeOrder", "sym:src/services/orders.ts#cancelOrder"];
    const plain = lensNew(repo, q);
    expect(users.every((u) => top(plain.candidates.map((c) => c.id)).includes(u))).toBe(false);
    const pack = lensNew(repo, q, { thread: "db" });
    expect(top(pack.candidates.map((c) => c.id))).toEqual(expect.arrayContaining([...users, "sym:src/db.ts#prisma"]));
    expect(pack.candidates.find((c) => c.id === "sym:src/services/orders.ts#placeOrder")).toMatchObject({ via: "thread", thread: expect.any(Number) });
    expect(pack.thread).toMatchObject({ id: "db", turns: 1, inPlay: ["sym:src/db.ts#prisma"], seeds: [{ id: "sym:src/db.ts#prisma", weight: 1 }] });
    expect(pack.file).toBe(".ultraview/conversations/db.draft.json");
    expect(pack.template).toMatchObject({ question: q, lang: "en", mode: "business", followUps: ["…", "…", "…"] });
    expect(pack.text).toContain("## Conversation so far (thread db: 1 turn(s); most recent last)");
    expect(pack.text).toContain("Pointed at by the conversation (no question word matched):");
    expect(pack.text).toContain("run `ultraview lens save .ultraview/conversations/db.draft.json --thread db`");
    expect(pack.text).toContain("Point the user at `#chat=db`");
    expect(lensNew(repo, q, { thread: "db" })).toEqual(pack);
    expect(() => lensNew(repo, q, { thread: "db", id: "x" })).toThrow(/--id names a lens/);

    // "who calls it?": the route whose handler calls the previous turn's function.
    writeView(repo, "conversations/cancel.json", {
      id: "cancel",
      title: "Cancel",
      createdAt: NOW.toISOString(),
      turns: [storedTurn({ answer: { answer: "It sets the status. [src/services/orders.ts:26]", nodes: ["sym:src/services/orders.ts#cancelOrder"] } })],
    });
    const calls = lensNew(repo, "ok, and who calls it?", { thread: "cancel" }).candidates.map((c) => c.id);
    expect(top(calls)).toContain("route:DELETE /api/orders/:id");
    // A topic switch still finds what it names.
    expect(top(lensNew(repo, "btw, what does the health check actually return?", { thread: "cancel" }).candidates.map((c) => c.id))).toContain(
      "route:GET /health",
    );
  });

  it("ranks what the question was asked about first, and refuses an unknown context", async () => {
    const repo = await builtShop(cleanups, { model: false });
    const pack = lensNew(repo, "wait, what even is this?", { context: { node: "entity:Product" } });
    expect(pack.candidates[0]!.id).toBe("entity:Product");
    expect(pack.context).toEqual({ value: { node: "entity:Product" }, nodes: ["entity:Product"] });
    expect(pack.text).toContain("about     node entity:Product (Product)");
    // Without a thread the template stays a lens's.
    expect(pack.template).toMatchObject({ schema: 1, id: "wait-what-even-is-this" });
    expect(lensNew(repo, "and this?", { context: { edge: "entity:Order -> entity:OrderItem" } }).context?.nodes).toEqual(["entity:Order", "entity:OrderItem"]);
    expect(() => lensNew(repo, "what?", { context: { node: "entity:Ghost" } })).toThrow(/unknown node: entity:Ghost/);
    expect(() => lensNew(repo, "what?", { context: { edge: "entity:Order" } })).toThrow(/context.edge must be/);
    const view = { byId: new Map(), flows: [{ schema: 1 as const, id: "f", title: "F", steps: [{ node: "entity:Order", note: "n" }] }], insights: [] };
    expect(resolveContext(view, { step: "f:2" })).toEqual({ error: "context.step: unknown flow step: f:2" });
    expect(resolveContext(view, { step: "f:1" })).toEqual({ nodes: [], lines: ['step 1 of flow f ("F"): entity:Order'] });
  });
});

describe("check and promote", () => {
  it("checks every turn, reports stale turns like stale lenses, and promotes a turn to a lens", async () => {
    const repo = await builtShop(cleanups);
    expect(saveTurn(repo, placeTurn(), { create: { id: "orders" }, now: NOW }).ok).toBe(true);
    expect(checkMap(repo)).toMatchObject({ ok: true, warnings: [] });

    // A turn edited by hand is checked like a lens: node ids, citations, every sentence cited.
    const file = join(repo, ".ultraview/conversations/orders.json");
    const good = readFileSync(file, "utf8");
    const broken = JSON.parse(good);
    broken.turns[0].answer.nodes.push("entity:Ghost");
    broken.turns[0].answer.answer += " Uncited claim here.";
    writeFileSync(file, JSON.stringify(broken));
    expect(checkMap(repo).errors.map((e) => `${e.file} ${e.path}: ${e.message.slice(0, 30)}`)).toEqual([
      '.ultraview/conversations/orders.json turns[0].answer.nodes[3]: unknown node "entity:Ghost" (r',
      '.ultraview/conversations/orders.json turns[0].answer.answer: uncited sentence: "Uncited cla',
    ]);
    writeFileSync(file, JSON.stringify({ ...broken, turns: [{ ...broken.turns[0], followUps: [] }] }));
    expect(checkMap(repo).errors.map((e) => e.message)).toContain("an agent turn carries exactly 3 follow-ups (got 0)");
    writeFileSync(file, good);

    touch(repo, "src/services/orders.ts");
    const stale = checkMap(repo);
    expect(stale.warnings.map((w) => `${w.file} ${w.path}`)).toContain(".ultraview/conversations/orders.json turns[0]");
    expect(checkMap(repo, { strict: true }).errors.map((e) => e.path)).toContain("turns[0]");
    expect(chatList(repo).conversations[0]).toMatchObject({ id: "orders", stale: 1 });
    const shown = await run(["chat", "show", "orders", "--repo", repo]);
    expect(shown.out).toContain("## Turn 1  [en, dev, agent]");
    expect(shown.out).toContain("STALE");

    const promoted = promoteTurn(repo, "orders", 1, { proposeId: (q) => proposeLensId(repo, q).id });
    expect(promoted).toMatchObject({ ok: true, file: ".ultraview/lenses/how-does-placing-an-order-work.json" });
    const lens = JSON.parse(readFileSync(join(repo, promoted.file!), "utf8"));
    expect(lens).toMatchObject({
      schema: 1,
      id: "how-does-placing-an-order-work",
      question: placeTurn().question,
      nodes: placeTurn().nodes,
      focus: "route:POST /api/orders",
    });
    expect(() => promoteTurn(repo, "orders", 2, { proposeId: () => "x" })).toThrow(/has no turn 2/);
  });
});

describe("chat CLI", () => {
  it("starts, lists, shows and appends to a conversation from the terminal", async () => {
    const repo = await builtShop(cleanups);
    const created = await run(["chat", "new", "--title", "Orders", "--json", "--repo", repo]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.out)).toMatchObject({ id: "orders", title: "Orders", turns: [] });

    const pack = await run(["lens", "new", "How does placing an order work?", "--thread", "orders", "--repo", repo]);
    expect(pack.code).toBe(0);
    expect(pack.out).toContain("thread    orders (turn 1)");
    const draft = join(repo, ".ultraview/conversations/orders.draft.json");
    writeFileSync(draft, JSON.stringify(placeTurn()));
    const saved = await run(["lens", "save", draft, "--thread", "orders", "--repo", repo]);
    expect(saved.code).toBe(0);
    expect(saved.out).toContain("saved      turn 1 of .ultraview/conversations/orders.json");
    expect(saved.out).toContain("#chat=orders");
    // The draft is not a conversation.
    expect(chatList(repo).conversations.map((c) => c.id)).toEqual(["orders"]);

    const ctx = await run(["lens", "new", "and this?", "--thread", "orders", "--context", '{"node":"entity:OrderItem"}', "--json", "--repo", repo]);
    expect(JSON.parse(ctx.out).candidates[0].id).toBe("entity:OrderItem");
    expect((await run(["lens", "new", "x", "--context", "{nope", "--repo", repo])).code).toBe(2);
    expect((await run(["lens", "new", "x", "--context", '{"what":"x"}', "--repo", repo])).err).toContain('unknown context key "what"');

    const list = await run(["chat", "list", "--repo", repo]);
    expect(list.out).toContain("orders  1 turn(s)");
    const promote = await run(["chat", "promote", "orders", "1", "--lens-id", "placing", "--repo", repo]);
    expect(promote.code).toBe(0);
    expect(promote.out).toContain("#lens=placing");
    expect((await run(["chat", "promote", "orders", "zero", "--repo", repo])).code).toBe(2);
    expect((await run(["chat", "nope", "--repo", repo])).code).toBe(2);
    expect((await run(["check", "--repo", repo])).code).toBe(0);
  });
});

describe("guessLang", () => {
  it("tags a question's language for a turn the agent did not tag", () => {
    expect(guessLang("How does cancelling an order work?")).toBe("en");
    expect(guessLang("Comment annule-t-on une commande ?")).toBe("fr");
    expect(guessLang("¿Cómo se cancela un pedido?")).toBe("es");
    expect(guessLang("Wie wird eine Bestellung storniert?")).toBe("de");
    expect(guessLang("注文はどうやってキャンセルしますか？")).toBe("ja");
    expect(guessLang("订单是怎么取消的？")).toBe("zh");
    expect(guessLang("Как отменить заказ?")).toBe("ru");
    expect(guessLang("???")).toBe("und");
  });
});
