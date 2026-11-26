import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { lensList, lensNew, proposeLensId, questionSlug, questionTerms } from "../src/lens.js";
import { isBridged, OWN_WORD_WEIGHT, readQuestion, SYNONYM_WEIGHT, verbMethods } from "../src/lens-terms.js";
import { saveLens } from "../src/save.js";
import { builtShop, captureIo, readModelFile, touch } from "./helpers.js";

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

const QUESTION = "How does cancelling an order work?";

describe("lens new", () => {
  it("builds a deterministic evidence pack", async () => {
    const repo = await builtShop(cleanups);
    const pack = lensNew(repo, QUESTION);
    expect(pack).toMatchObject({ id: "how-does-cancelling-an-order-work", file: ".ultraview/lenses/how-does-cancelling-an-order-work.json", reask: false });
    expect(pack.terms).toEqual(["cancel", "order"]);
    // ultraindex find, mapped to view ids, then the facts and symbols named like the question.
    expect(pack.candidates.filter((c) => c.via === "find").map((c) => c.id)).toContain("mod:src-services");
    expect(pack.candidates.find((c) => c.via === "name")).toMatchObject({ id: "sym:src/services/orders.ts#cancelOrder", matched: ["cancel", "order"] });
    expect(pack.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(["route:DELETE /api/orders/:id", "entity:Order"]));
    expect(pack.capabilities.map((c) => c.id)).toEqual(["cap:order-tracking", "cap:ordering"]);
    expect(pack.template).toMatchObject({ schema: 1, id: pack.id, question: QUESTION, focus: "sym:src/services/orders.ts#cancelOrder" });
    expect(pack.evidence[0]!.range).toBe("src/services/orders.ts:22-28");
    expect(pack.text).toContain("## Template\n```json\n{");
    expect(pack.text.trimEnd().split("\n").at(-1)).toBe(
      "6. Point the user at `#lens=how-does-cancelling-an-order-work` in the map (live when `ultraview serve` runs).",
    );
    expect(pack.text).toContain("Run `ultraview lens save .ultraview/lenses/how-does-cancelling-an-order-work.json`, then `ultraview check`");
    expect(lensNew(repo, QUESTION)).toEqual(pack);
    await expect(pack.text).toMatchFileSnapshot("./__snapshots__/shop.lens-new.txt");
  });

  it("keeps the template and instructions inside a small budget", async () => {
    const repo = await builtShop(cleanups);
    const small = lensNew(repo, QUESTION, { budget: 900 });
    expect(small.evidence.length).toBeLessThan(lensNew(repo, QUESTION).evidence.length);
    expect(small.text).toContain("cut to the ~900-token budget");
    expect(small.text).toContain("## Template");
    expect(small.text).toContain("## Next");
  });

  it("de-duplicates the id against saved lenses; the same question keeps its id", async () => {
    const repo = await builtShop(cleanups);
    expect(questionSlug("Comment créer une commande ?")).toBe("comment-creer-une-commande");
    expect(questionSlug("???")).toMatch(/^lens-[0-9a-f]{6}$/);
    expect(questionSlug("a ".repeat(40)).length).toBeLessThanOrEqual(48);
    expect(questionTerms("Shipping the orders, cancelled entries")).toEqual(["cancel", "entry", "order", "ship"]);
    const lens = { ...readModelFile("shop.lens.json"), id: "how-does-cancelling-an-order-work", question: "Something else entirely?" };
    expect(saveLens(repo, lens).ok).toBe(true);
    expect(proposeLensId(repo, QUESTION)).toEqual({ id: "how-does-cancelling-an-order-work-2", reask: false });
    expect(proposeLensId(repo, "Something else entirely?")).toEqual({ id: "how-does-cancelling-an-order-work", reask: true });
    expect(lensNew(repo, QUESTION).id).toBe("how-does-cancelling-an-order-work-2");
    // An explicit --id that holds another question is kept, with the conflict spelled out.
    const forced = lensNew(repo, QUESTION, { id: "how-does-cancelling-an-order-work" });
    expect(forced.conflict).toBe("Something else entirely?");
    expect(forced.text).toContain("save with --force");
    expect(() => lensNew(repo, QUESTION, { id: "Not A Slug" })).toThrow(/--id must be a slug/);
  });

  it("gives a question in any script a readable, distinct id: its slug, else its --terms, else a hash", async () => {
    const repo = await builtShop(cleanups);
    const ja = "注文はどのように取り消されますか？";
    const zh = "订单是如何取消的？";
    const ar = "كيف يتم إلغاء الطلب؟";
    const ru = "Как отменяется заказ?";
    const ids = [ja, zh, ar, ru].map((q) => questionSlug(q));
    for (const id of ids) expect(id).toMatch(/^lens-[0-9a-f]{6}$/);
    expect(new Set(ids).size).toBe(4);
    // Stable: the same question (up to spacing and width) hashes the same.
    expect(questionSlug(ja)).toBe(ids[0]);
    expect(questionSlug(` ${ja.replace("？", "?")}  `)).toBe(ids[0]);
    // The agent's English terms name it when given.
    expect(questionSlug(ja, "order cancel")).toBe("order-cancel");
    expect(questionSlug(ar, "  Order, Cancel!  ")).toBe("order-cancel");
    expect(questionSlug(ru, "???")).toBe(ids[3]);
    // A few Latin letters in another script are too little to name it ("api", "2")...
    expect(questionSlug("APIの使い方は？")).toMatch(/^lens-[0-9a-f]{6}$/);
    expect(questionSlug("APIの使い方は？", "api usage")).toBe("api-usage");
    expect(questionSlug("订单 2 是如何取消的？")).toMatch(/^lens-[0-9a-f]{6}$/);
    // ...while a Latin-script question keeps its slug, terms or not.
    expect(questionSlug("Comment créer une commande ?", "order create")).toBe("comment-creer-une-commande");
    expect(questionSlug("Why?")).toBe("why");

    // Two different questions never share an id; the same one keeps its lens.
    const save = (id: string, question: string) => expect(saveLens(repo, { ...readModelFile("shop.lens.json"), id, question }).ok).toBe(true);
    const jaId = proposeLensId(repo, ja);
    expect(jaId).toEqual({ id: ids[0], reask: false });
    save(jaId.id, ja);
    expect(proposeLensId(repo, ja)).toEqual({ id: ids[0], reask: true });
    expect(proposeLensId(repo, zh)).toEqual({ id: ids[1], reask: false });
    expect(lensNew(repo, ja)).toMatchObject({ id: ids[0], reask: true });
    // The same terms for another question: suffixed, never the saved lens.
    expect(proposeLensId(repo, zh, "order cancel")).toEqual({ id: "order-cancel", reask: false });
    save("order-cancel", zh);
    expect(proposeLensId(repo, ar, "order cancel")).toEqual({ id: "order-cancel-2", reask: false });
    expect(proposeLensId(repo, zh, "something else")).toEqual({ id: "order-cancel", reask: true });
    const pack = lensNew(repo, ru, { terms: "order cancel" });
    expect(pack).toMatchObject({ id: "order-cancel-2", file: ".ultraview/lenses/order-cancel-2.json", reask: false });
    expect(pack.template).toMatchObject({ id: "order-cancel-2", question: ru });
    // A hash taken by another question (a hand-written file) is suffixed too.
    save(ids[2]!, "Something else entirely?");
    expect(proposeLensId(repo, ar)).toEqual({ id: `${ids[2]}-2`, reask: false });
  });

  it("ranks named nodes by rare terms, the kind, method and cardinality the wording points at", async () => {
    const repo = await builtShop(cleanups);
    const top = (q: string, n = 3) =>
      lensNew(repo, q)
        .candidates.slice(0, n)
        .map((c) => c.id);
    // Data words point at entities; a relation question finds the join entity through its fields.
    expect(top("Which fields does an order record contain?", 2).sort()).toEqual(["entity:Order", "entity:OrderItem"]);
    expect(top("How are products linked to orders?", 3)).toEqual(expect.arrayContaining(["entity:Product", "entity:OrderItem"]));
    // A verb points at a method, "by its id" at a route naming one item.
    expect(top("How do I fetch a specific order by its ID?", 1)).toEqual(["route:GET /api/orders/:id"]);
    // A synonym (status → health) at a lower weight, and a word found only in a definition body (`cancelOrder` in the DELETE handler).
    expect(top("If the API is queried for its status, what comes back?", 1)).toEqual(["route:GET /health"]);
    expect(top("What happens when an order is cancelled?", 2).sort()).toEqual(["route:DELETE /api/orders/:id", "sym:src/services/orders.ts#cancelOrder"]);
    // Named nodes come before the modules ultraindex finds.
    const pack = lensNew(repo, QUESTION);
    expect(pack.candidates.findIndex((c) => c.via === "find")).toBe(pack.candidates.filter((c) => c.via === "name").length);
  });

  it("reads a French question through the lexicon of everyday app words", async () => {
    const r = readQuestion("Que devient une commande quand elle est annulée ?");
    expect(r.bridged).toBe(true);
    expect(r.terms).toEqual(expect.arrayContaining(["cancel", "order"]));
    expect(r.terms).not.toContain("est");
    expect([...r.methods]).toEqual(["DELETE"]);
    expect(readQuestion("Quels champs composent une fiche commande ?").kinds.has("entity")).toBe(true);
    expect(readQuestion("Que se passe-t-il si je me trompe de mot de passe ?").terms).toContain("password");
    // English stays English: `command` is not `commande`, and kind words are hints, never terms.
    const en = readQuestion("Which route runs the build command?");
    expect(en.bridged).toBe(false);
    expect(en.terms).toEqual(["build", "command", "run"]);
    expect(en.kinds.has("route")).toBe(true);
    expect(readQuestion("Can I buy it?").weight.get("order")).toBe(SYNONYM_WEIGHT);
    expect(readQuestion("List every order").cardinality).toBe("all");
    expect(readQuestion("Show one order by id").cardinality).toBe("one");
    expect(questionTerms("What is the status of the service?")).toEqual(["health", "service", "status"]);

    const repo = await builtShop(cleanups);
    const top = (q: string, n: number) =>
      lensNew(repo, q)
        .candidates.slice(0, n)
        .map((c) => c.id);
    expect(top("Que devient une commande quand elle est annulée ?", 2).sort()).toEqual([
      "route:DELETE /api/orders/:id",
      "sym:src/services/orders.ts#cancelOrder",
    ]);
    expect(top("Que renvoie exactement le endpoint de santé ?", 1)).toEqual(["route:GET /health"]);
    expect(top("Comment récupérer une commande précise à partir de son identifiant ?", 1)).toEqual(["route:GET /api/orders/:id"]);
  });

  it("merges the supplied English terms into the reading of a question in any language", () => {
    // Terms weigh 1 and are stemmed like English words; synonyms apply to them as to the question's words.
    const es = readQuestion("¿Qué pasa con un pedido cuando se cancela?", "order cancel purchases");
    expect(es.bridged).toBe(true);
    expect(es.weight.get("order")).toBe(1);
    expect(es.weight.get("cancel")).toBe(1);
    expect(es.weight.get("purchase")).toBe(1);
    // The question's own words stay, below the terms; short ones (`con`, `que`) are left out.
    expect(es.weight.get("pedido")).toBe(OWN_WORD_WEIGHT);
    expect(es.terms).not.toContain("con");
    expect(es.terms).not.toContain("que");
    // The hints read the terms too: `cancel` points at DELETE, `purchases` at POST.
    expect([...es.methods].sort()).toEqual(["DELETE", "POST"]);
    // An English question keeps its own words at weight 1 next to the terms.
    const en = readQuestion("What happens when an order is cancelled?", "refund");
    expect(en.bridged).toBe(false);
    expect(en.weight.get("order")).toBe(1);
    expect(en.weight.get("refund")).toBe(1);
    // With terms, a French question is read through them, not the lexicon.
    const fr = readQuestion("Que devient une commande quand elle est annulée ?", "order cancel");
    expect(fr.bridged).toBe(true);
    expect(fr.terms).toEqual(["annulee", "cancel", "commande", "order"]);
    expect(fr.weight.get("commande")).toBe(OWN_WORD_WEIGHT);
    expect(questionTerms("Как отменить заказ?", "cancel order")).toEqual(expect.arrayContaining(["cancel", "order"]));
  });

  it("calls a question bridged when it is not English", () => {
    // A French marker, with or without terms.
    expect(isBridged("Comment annuler une commande ?")).toBe(true);
    // Mostly non-Latin letters: Cyrillic, Arabic, CJK.
    expect(isBridged("Как отменить заказ?")).toBe(true);
    expect(isBridged("كيف يتم إلغاء الطلب؟")).toBe(true);
    expect(isBridged("注文をキャンセルするとどうなりますか？")).toBe(true);
    expect(isBridged("取消订单 API 会返回什么？")).toBe(true);
    // A Latin-script question without French markers: bridged only once terms say so and few of its words are English stopwords.
    expect(isBridged("¿Dónde pueden los clientes ver sus pedidos?")).toBe(false);
    expect(isBridged("¿Dónde pueden los clientes ver sus pedidos?", "customer order list")).toBe(true);
    expect(isBridged("Wie wird eine Bestellung storniert?", "order cancel")).toBe(true);
    // English stays English, terms or not.
    expect(isBridged("How does cancelling an order work?")).toBe(false);
    expect(isBridged("How does cancelling an order work?", "cancel order")).toBe(false);
    expect(isBridged("Which route returns the API status?", "health")).toBe(false);
  });

  it("reads the verb of a verb-noun symbol name as the method it points at", async () => {
    expect(verbMethods("placeOrder")).toEqual(["POST"]);
    expect(verbMethods("cancelOrder")).toEqual(["DELETE"]);
    expect(verbMethods("listOrders")).toEqual(["GET"]);
    // A one-word name (a Next handler named GET) is its route's twin: no bonus of its own.
    expect(verbMethods("GET")).toEqual([]);
    expect(verbMethods("orderTotal")).toEqual([]);
    // `buy` points at POST, so placeOrder rises above the other order symbols.
    const repo = await builtShop(cleanups);
    const ids = lensNew(repo, "Was passiert, wenn ein Kunde etwas kauft?", { terms: "customer buy order" }).candidates.map((c) => c.id);
    expect(ids.indexOf("sym:src/services/orders.ts#placeOrder")).toBeLessThan(ids.indexOf("sym:src/services/orders.ts#listOrders"));
    expect(ids.slice(0, 3)).toContain("route:POST /api/orders");
  });

  it("keeps words in any script, as the engine splits them", () => {
    expect(readQuestion("Как отменить заказ?").terms).toEqual(expect.arrayContaining(["заказ", "отменить"]));
    expect(readQuestion("ما هي حالة الطلب؟").terms).toEqual(expect.arrayContaining(["الطلب", "حالة"]));
    expect(readQuestion("购物车 页面").terms).toEqual(["购物车", "页面"]);
    // Still no one-letter Latin words, and English stems are not applied to other scripts.
    expect(readQuestion("Заказы и товары").terms).toEqual(expect.arrayContaining(["заказы", "товары"]));
    // A run-together identifier in the question is split like code.
    expect(readQuestion("Where is cancelOrder called?").terms).toEqual(expect.arrayContaining(["cancel", "order"]));
  });

  it("lens new --terms ranks a question in another language like its English twin", async () => {
    const repo = await builtShop(cleanups);
    const top = (q: string, terms: string | undefined, n: number) =>
      lensNew(repo, q, terms === undefined ? {} : { terms })
        .candidates.slice(0, n)
        .map((c) => c.id);
    const ru = "Что происходит с заказом, когда его отменяют?";
    const without = lensNew(repo, ru);
    expect(without.bridged).toBe(true);
    expect(without.text).toContain('reading   not English and no --terms: pass --terms "<English code keywords>"');
    const pack = lensNew(repo, ru, { terms: "order cancel delete" });
    expect(pack).toMatchObject({ bridged: true, suppliedTerms: "order cancel delete" });
    expect(pack.text).toContain("reading   not English: read through --terms");
    expect(top(ru, "order cancel delete", 2).sort()).toEqual(["route:DELETE /api/orders/:id", "sym:src/services/orders.ts#cancelOrder"]);
    expect(top("¿Cómo se obtiene un pedido concreto por su identificador?", "get order by id", 1)).toEqual(["route:GET /api/orders/:id"]);
    // An English question reads the same with no --terms: nothing new in its pack.
    const en = lensNew(repo, QUESTION);
    expect(en.bridged).toBe(false);
    expect(en.suppliedTerms).toBeUndefined();
    expect(en.text).not.toContain("reading ");
    const r = await run(["lens", "new", ru, "--terms", "order cancel", "--repo", repo, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ bridged: true, suppliedTerms: "order cancel" });
  });

  it("lens new --json returns the structured pack; usage errors exit 2", async () => {
    const repo = await builtShop(cleanups);
    const r = await run(["lens", "new", QUESTION, "--repo", repo, "--json", "--budget", "2000"]);
    expect(r.code).toBe(0);
    const pack = JSON.parse(r.out);
    expect(pack).toMatchObject({ id: "how-does-cancelling-an-order-work", budget: 2000 });
    expect(Array.isArray(pack.candidates)).toBe(true);
    expect((await run(["lens", "--repo", repo])).code).toBe(2);
    expect((await run(["lens", "new", "--repo", repo])).code).toBe(2);
    expect((await run(["lens", "nope", "x", "--repo", repo])).code).toBe(2);
    expect((await run(["lens", "new", QUESTION, "--budget", "0", "--repo", repo])).code).toBe(2);
  });
});

describe("lens list", () => {
  it("lists saved lenses with the stale flag check uses", async () => {
    const repo = await builtShop(cleanups, { views: true });
    const fresh = lensList(repo);
    expect(fresh.lenses).toEqual([
      expect.objectContaining({ id: "how-cancel-works", question: "How does cancelling an order work?", nodes: 3, stale: false, stamped: true }),
    ]);
    expect(fresh.lenses[0]!.saved).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Asking a saved question again reuses its id (a re-ask replaces the answer).
    expect(proposeLensId(repo, "How does cancelling an order work?")).toEqual({ id: "how-cancel-works", reask: true });
    expect(lensNew(repo, "How does cancelling an order work?").text).toContain("id        how-cancel-works  (re-ask: a saved lens holds this question)");
    touch(repo, "src/services/orders.ts");
    expect(lensList(repo).lenses[0]!.stale).toBe(true);
    const text = await run(["lens", "list", "--repo", repo]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("lenses     1 saved, 1 stale\n  how-cancel-works  3 node(s)");
    expect(text.out).toContain("[STALE]");
    const json = JSON.parse((await run(["lens", "list", "--repo", repo, "--json"])).out);
    expect(json.lenses[0]).toMatchObject({ id: "how-cancel-works", stale: true });
  });

  it("says so when nothing is saved", async () => {
    const repo = await builtShop(cleanups);
    expect((await run(["lens", "list", "--repo", repo])).out).toContain("none saved yet");
  });
});
