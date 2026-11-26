// Card labels on two lines (issue #14): the deterministic width estimate, the
// wrapping (two lines at most, an ellipsis past them, CJK and long words), the
// card sizes the scenes hand to ELK, and the full label kept in the card's
// tooltip and accessible name. Runs in node: nothing here touches the DOM.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ViewModel } from "../src/model/types.js";
import { buildIndex } from "../viewer/lib/data.js";
import { BADGE_ROOM, buildScene, erdScene, SIZE, subgraphScene } from "../viewer/lib/levels.js";
import { CARD_TEXT, cardLines, cardSize, ELLIPSIS, estimateWidth, LABEL_LINES, labelRoom, wrapLabel } from "../viewer/lib/wrap.js";
import { cardAria, cardTitle } from "../viewer/lib/cards.js";

const LONG = "Publishing content to the public site";
const LONGER = "Answering labour-law questions for employers and their staff in every region of the country";
const view = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/shop.view.json"), "utf8")) as ViewModel;

/** The shop view with its capabilities, a system and a module renamed to long labels. */
function longView(): ViewModel {
  const v = structuredClone(view);
  const rename: Record<string, string> = {
    "cap:ordering": LONG,
    "cap:order-tracking": LONGER,
    "sys:api": "Customer-facing storefront and checkout server",
    "mod:src-services": "Order placement and cancellation services",
  };
  for (const n of v.nodes as { id: string; label: string }[]) if (rename[n.id]) n.label = rename[n.id]!;
  return v;
}

describe("width estimate", () => {
  it("is a pure function of the text and the size", () => {
    expect(estimateWidth(LONG, 13)).toBe(estimateWidth(LONG, 13));
    expect(estimateWidth(LONG, 26)).toBeCloseTo(2 * estimateWidth(LONG, 13), 6);
    expect(estimateWidth("", 13)).toBe(0);
    expect(estimateWidth("WWW", 13)).toBeGreaterThan(estimateWidth("iii", 13));
  });

  it("reads an accented letter as its base letter and a CJK character as one em", () => {
    expect(estimateWidth("réclamé", 13)).toBe(estimateWidth("reclame", 13));
    expect(estimateWidth("注文", 10)).toBeCloseTo(20.2, 6);
    expect(estimateWidth("한글", 10)).toBeCloseTo(20.2, 6);
  });
});

describe("wrapLabel", () => {
  const room = 152;

  it("leaves a label that fits on one line", () => {
    expect(wrapLabel("Placing an order", room, 13)).toEqual({ lines: ["Placing an order"], cut: false });
    expect(wrapLabel("  Placing   an order ", room, 13)).toEqual({ lines: ["Placing an order"], cut: false });
  });

  it("breaks at a space, every line within the room, nothing lost", () => {
    const w = wrapLabel(LONG, room, 13);
    expect(w.cut).toBe(false);
    expect(w.lines).toHaveLength(2);
    expect(w.lines.join(" ")).toBe(LONG);
    for (const l of w.lines) expect(estimateWidth(l, 13)).toBeLessThanOrEqual(room);
    for (const l of w.lines) expect(l).toBe(l.trim());
  });

  it("may break after a hyphen", () => {
    const w = wrapLabel("Answering labour-law questions", 120, 13);
    expect(w.lines[0]).toBe("Answering labour-");
    expect(w.lines.join("")).toBe("Answering labour-law questions");
  });

  it("stops at two lines and ends the second with an ellipsis", () => {
    const w = wrapLabel(LONGER, room, 13);
    expect(w.cut).toBe(true);
    expect(w.lines).toHaveLength(2);
    expect(w.lines[1]!.endsWith(ELLIPSIS)).toBe(true);
    expect(w.lines[1]!.endsWith(` ${ELLIPSIS}`)).toBe(false);
    for (const l of w.lines) expect(estimateWidth(l, 13)).toBeLessThanOrEqual(room);
    expect(LONGER.startsWith(`${w.lines[0]} ${w.lines[1]!.slice(0, -1)}`)).toBe(true);
  });

  it("honours another line limit", () => {
    expect(wrapLabel(LONGER, room, 13, 1).lines).toHaveLength(1);
    expect(wrapLabel(LONGER, room, 13, 1).cut).toBe(true);
    const three = wrapLabel(LONGER, room, 13, 3);
    expect(three.lines).toHaveLength(3);
  });

  it("breaks a word longer than a line where it reaches the edge", () => {
    const word = "PaymentReconciliationServiceImplementation";
    const w = wrapLabel(word, room, 13);
    expect(w.cut).toBe(false);
    expect(w.lines).toHaveLength(2);
    expect(w.lines.join("")).toBe(word);
    for (const l of w.lines) expect(estimateWidth(l, 13)).toBeLessThanOrEqual(room);
    // the first line is as full as the room allows
    expect(estimateWidth(`${w.lines[0]}${w.lines[1]![0]}`, 13)).toBeGreaterThan(room);
    const huge = wrapLabel(word.repeat(3), room, 13);
    expect(huge.cut).toBe(true);
    expect(huge.lines[1]!.endsWith(ELLIPSIS)).toBe(true);
  });

  it("breaks CJK text between characters, without spaces", () => {
    const ja = "注文を確定して支払いを処理し配送を手配する";
    const w = wrapLabel(ja, room, 13);
    expect(w.lines).toHaveLength(2);
    expect(w.lines.join("")).toBe(ja);
    for (const l of w.lines) expect(estimateWidth(l, 13)).toBeLessThanOrEqual(room);
    const mixed = wrapLabel("Checkout 注文を確定して支払いを処理し配送", room, 13);
    expect(mixed.lines.join("").replace(/\s/g, "")).toBe("Checkout注文を確定して支払いを処理し配送");
  });

  it("never splits a surrogate pair", () => {
    const w = wrapLabel("𠀀".repeat(30), room, 13);
    for (const l of w.lines) expect(l.replace(ELLIPSIS, "")).toMatch(/^(?:𠀀)+$/u);
  });

  it("is deterministic", () => {
    const runs = Array.from({ length: 5 }, () => wrapLabel(LONGER, room, 13));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });
});

describe("cardSize", () => {
  it("keeps the size of every card whose label fits one line", () => {
    for (const role of ["card", "cluster", "chip", "ghost"] as const) expect(cardSize(role, "Orders")).toEqual(SIZE[role]);
    expect(cardSize("card", "Placing an order")).toEqual(SIZE.card);
  });

  it("leaves roles it does not wrap alone", () => {
    expect(cardSize("agg", LONGER)).toBeUndefined();
    expect(cardSize("group", LONGER)).toBeUndefined();
  });

  it("grows a card one line taller for a label on two lines, at its usual width when that is enough", () => {
    expect(cardSize("card", LONG)).toEqual({ w: SIZE.card.w, h: SIZE.card.h + CARD_TEXT.card.line });
    const chip = cardSize("chip", "Back-office administrator")!;
    expect(chip).toEqual({ w: SIZE.chip.w, h: SIZE.chip.h + CARD_TEXT.chip.line });
  });

  it("widens, within its cap, before it cuts", () => {
    const label = "Answering labour-law questions for employers";
    const s = cardSize("card", label)!;
    expect(s.w).toBeGreaterThan(SIZE.card.w);
    expect(s.w).toBeLessThanOrEqual(CARD_TEXT.card.maxW);
    expect(cardLines("card", label, s.w).cut).toBe(false);
    // and is the narrowest step that holds it
    expect(cardLines("card", label, s.w - 8).cut).toBe(true);
  });

  it("cuts on the second line only past the widest card", () => {
    const s = cardSize("card", LONGER)!;
    expect(s).toEqual({ w: CARD_TEXT.card.maxW, h: SIZE.card.h + CARD_TEXT.card.line });
    const lines = cardLines("card", LONGER, s.w);
    expect(lines.cut).toBe(true);
    expect(lines.lines).toHaveLength(LABEL_LINES);
  });

  it("keeps room for a flow step badge when asked", () => {
    const plain = cardSize("card", "Order placement services")!;
    const badged = cardSize("card", "Order placement services", BADGE_ROOM)!;
    expect(labelRoom("card", 216, BADGE_ROOM)).toBe(labelRoom("card", 216) - BADGE_ROOM);
    expect(badged.h).toBeGreaterThanOrEqual(plain.h);
  });
});

describe("scenes size cards to their labels", () => {
  const ix = buildIndex(longView());

  it("Business: long capabilities wrap, short ones keep their card", () => {
    const s = buildScene(ix, { level: "biz" }, "business");
    const byId = new Map(s.nodes.map((n) => [n.id, n]));
    expect(byId.get("cap:ordering")).toMatchObject({ label: LONG, w: 216, h: 80 });
    expect(byId.get("cap:order-tracking")).toMatchObject({ label: LONGER, w: CARD_TEXT.card.maxW, h: 80 });
    expect(byId.get("cap:health")).toMatchObject({ w: 216, h: 64 });
    // same index, same scene, same sizes
    const again = buildScene(ix, { level: "biz" }, "business");
    expect(again.nodes.map((n) => [n.id, n.w, n.h])).toEqual(s.nodes.map((n) => [n.id, n.w, n.h]));
  });

  it("systems and modules wrap too", () => {
    const sys = buildScene(ix, { level: "sys" }, "business").nodes.find((n) => n.id === "sys:api")!;
    expect(sys.h).toBe(80);
    const mod = buildScene(ix, { level: "mod" }, "developer").nodes.find((n) => n.id === "mod:src-services")!;
    expect(mod.h).toBe(80);
  });

  it("lens and flow subgraphs wrap, a flow keeping room for its step badges", () => {
    const lens = subgraphScene(ix, "lens:x", ["cap:ordering", "cap:health"]);
    expect(lens.nodes.find((n) => n.id === "cap:ordering")).toMatchObject({ w: 216, h: 80 });
    expect(lens.nodes.find((n) => n.id === "cap:health")).toMatchObject({ w: 216, h: 64 });
    const flow = subgraphScene(ix, "flow:x", ["cap:ordering"], [], { badged: true });
    const card = flow.nodes[0]!;
    expect(card).toEqual(expect.objectContaining(cardSize("card", LONG, BADGE_ROOM)));
    expect(cardLines("card", LONG, card.w, BADGE_ROOM).cut).toBe(false);
  });

  it("the Data view keeps its own card sizes", () => {
    for (const n of erdScene(ix).nodes) expect(n.w).toBe(232);
  });

  it("the tooltip and the accessible name carry the whole label", () => {
    const s = buildScene(ix, { level: "biz" }, "business");
    for (const id of ["cap:ordering", "cap:order-tracking"]) {
      const n = s.nodes.find((x) => x.id === id)!;
      expect(cardTitle(n)).toBe(n.label);
      expect(cardAria(ix, n, "business")).toContain(n.label);
    }
    // even when the card cuts it
    const cut = s.nodes.find((x) => x.id === "cap:order-tracking")!;
    expect(cardLines(cut.role, cut.label, cut.w).cut).toBe(true);
    expect(cardTitle(cut)).toBe(LONGER);
    expect(cardAria(ix, cut, "business")).toContain(LONGER);
  });
});
