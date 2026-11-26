import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { lensList, lensNew, proposeLensId, questionSlug, questionTerms } from "../src/lens.js";
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
    expect(questionSlug("???")).toBe("lens");
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
