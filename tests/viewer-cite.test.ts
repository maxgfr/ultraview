// The viewer's citation grammar (viewer/lib/cite.ts, viewer/lib/markdown.ts)
// against the gates' (ultraindex's `parseCitations` / `checkCitations`, via
// src/engine.ts): every citation a check accepts is a chip, with the same path
// and lines. Framework route paths (`[id]`, `[[...params]]`, `(group)`,
// `+page`, `@modal`, `$id`) are the cases that used to stay plain text. Also:
// the per-turn chat actions carry distinct accessible names.

import { afterEach, describe, expect, it } from "vitest";
import { checkCitations, parseCitations as engineParse } from "../src/engine.js";
import { splitSentences, uncitedSentences } from "../src/model/prose.js";
import { type TurnAction, turnActionName } from "../viewer/lib/chat.js";
import { citationAt, parseCitations } from "../viewer/lib/cite.js";
import { setLang, t } from "../viewer/lib/i18n.js";
import { citeAt, citeLabel, parseCites, parseInline, stripCites } from "../viewer/lib/markdown.js";

afterEach(() => setLang("en"));

/** A chip as `path:line-end` (`path` alone for a whole file). */
const chip = (c: { path: string; line?: number; end?: number }) => `${c.path}${c.line !== undefined ? `:${c.line}` : ""}${c.end ? `-${c.end}` : ""}`;

/** text → the chips the viewer draws, in order. */
const CASES: [string, string[]][] = [
  // plain
  ["Stores it [src/a.ts:12].", ["src/a.ts:12"]],
  ["Stores it [src/a.ts:10-12].", ["src/a.ts:10-12"]],
  ["Same line [src/a.ts:4-4].", ["src/a.ts:4"]],
  ["A whole file [src/a.ts].", ["src/a.ts"]],
  ["A root file [README.md:3].", ["README.md:3"]],
  // brackets in the path (Next.js, Nuxt, SvelteKit)
  ["Lists alerts [targets/frontend/src/pages/alerts/[[...params]].tsx:175-185].", ["targets/frontend/src/pages/alerts/[[...params]].tsx:175-185"]],
  ["Shows one [app/[slug]/page.tsx:4].", ["app/[slug]/page.tsx:4"]],
  ["Catches all [app/[...slug]/page.tsx:1-9].", ["app/[...slug]/page.tsx:1-9"]],
  ["Two segments [app/[org]/[id]/page.tsx:2].", ["app/[org]/[id]/page.tsx:2"]],
  ["A dynamic file [src/pages/[id].ts:3].", ["src/pages/[id].ts:3"]],
  ["Nuxt [pages/users/[id].vue:7].", ["pages/users/[id].vue:7"]],
  ["Whole dynamic file [src/pages/[id].ts].", ["src/pages/[id].ts"]],
  // parentheses, plus signs, @ segments, $ and spaces
  ["A route group [app/(shop)/cart/page.tsx:5].", ["app/(shop)/cart/page.tsx:5"]],
  [
    "SvelteKit [src/routes/+page.svelte:2] and [src/routes/blog/[slug]/+page.server.ts:8-20].",
    ["src/routes/+page.svelte:2", "src/routes/blog/[slug]/+page.server.ts:8-20"],
  ],
  ["A parallel route [app/@modal/(.)photo/[id]/page.tsx:9].", ["app/@modal/(.)photo/[id]/page.tsx:9"]],
  ["Remix [app/routes/users.$id.tsx:11].", ["app/routes/users.$id.tsx:11"]],
  ["A space [docs/user guide/setup notes.md:3].", ["docs/user guide/setup notes.md:3"]],
  // en dash ranges: the viewer reads the lines (the gate rejects the citation)
  ["En dash [src/a.ts:3–5].", ["src/a.ts:3-5"]],
  ["Em dash [app/[id]/page.tsx:3—5].", ["app/[id]/page.tsx:3-5"]],
  // adjacency with punctuation and each other
  ["(see [src/a.ts:3]), then [src/b.ts:4];", ["src/a.ts:3", "src/b.ts:4"]],
  ["Back to back [src/a.ts:3][app/[id]/page.tsx:4].", ["src/a.ts:3", "app/[id]/page.tsx:4"]],
  ["Glued:[src/a.ts:3].Next", ["src/a.ts:3"]],
  ["Trailing dot inside [src/a.ts:3.] and comma [src/b.ts:4,]", ["src/a.ts:3", "src/b.ts:4"]],
  ["In bold **[src/a.ts:3]**", ["src/a.ts:3"]],
  ["Bracketed aside [see [src/a.ts:3]] ends.", ["src/a.ts:3"]],
  // not citations
  ["No path [Note:3] or [not a cite] or [Node.js] here.", []],
  ["A bare name with a space [a b.ts:3].", []],
  ["Three levels [a/[[[x]]]/b.ts:1].", []],
  ["Across lines [src/\na.ts:3].", []],
];

describe("citation grammar: the viewer reads what the gates read", () => {
  it.each(CASES)("draws the chips of %j", (text, chips) => {
    expect(parseCites(text).map(chip)).toEqual(chips);
  });

  it.each(CASES)("parses %j exactly like the engine", (text) => {
    expect(parseCitations(text)).toEqual(engineParse(text));
  });

  it("parity holds over every combination of route segments, line suffixes and punctuation", () => {
    const segments = ["[id]", "[...slug]", "[[...params]]", "(group)", "(.)photo", "+page", "@modal", "$id", "my dir", "a.b", "[a]-[b]"];
    const suffixes = ["", ":3", ":3-5", ":3–5", ":3.", ":0", ":3-", ":x"];
    const exts = [".tsx", ".svelte", ".server.ts", ""];
    const wraps: [string, string][] = [
      ["", ""],
      ["(", ")"],
      ["", "."],
      ["See ", ", then more."],
      ["**", "**"],
      ["`", "`"],
      ["[", "]"],
    ];
    let n = 0;
    for (const seg of segments) {
      for (const ext of exts) {
        for (const suf of suffixes) {
          for (const [pre, post] of wraps) {
            const cite = `[src/${seg}/page${ext}${suf}]`;
            const text = `${pre}${cite}${post} and [lib/${seg}${ext || ".ts"}${suf}]`;
            expect(parseCitations(text), text).toEqual(engineParse(text));
            // Every chip the viewer draws is a citation of the engine's, at the same path.
            const engine = new Set(engineParse(text).map((c) => c.path));
            for (const c of parseCites(text)) if (!suf.includes("–")) expect(engine.has(c.path), `${text} → ${c.path}`).toBe(true);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(2000);
  });

  it("the gate accepts the bracketed paths the viewer links, and refuses what it does not", () => {
    const lines = new Map([
      ["targets/frontend/src/pages/alerts/[[...params]].tsx", 300],
      ["app/(shop)/cart/page.tsx", 10],
      ["src/routes/+page.svelte", 10],
      ["app/@modal/(.)photo/[id]/page.tsx", 10],
      ["src/a.ts", 10],
      ["src/b.ts", 10],
    ]);
    const ok =
      "Lists alerts [targets/frontend/src/pages/alerts/[[...params]].tsx:175-185]. Groups [app/(shop)/cart/page.tsx:5]. Pages [src/routes/+page.svelte:2]. Modals [app/@modal/(.)photo/[id]/page.tsx:9].";
    const r = checkCitations(ok, lines);
    expect(r.unresolved).toEqual([]);
    expect(r.resolved.map((c) => c.path)).toEqual(parseCites(ok).map((c) => c.path));
    // One citation per bracket, ASCII hyphen ranges: the gate refuses the rest.
    expect(checkCitations("Both [src/a.ts:1, src/b.ts:2].", lines).ok).toBe(false);
    expect(checkCitations("Dash [src/a.ts:1–2].", lines).ok).toBe(false);
  });

  it("reads one token at a position, brackets and all", () => {
    expect(citationAt("x [app/[id]/page.tsx:3] y", 2)).toEqual({
      citation: { raw: "app/[id]/page.tsx:3", path: "app/[id]/page.tsx", start: 3 },
      length: "[app/[id]/page.tsx:3]".length,
    });
    expect(citationAt("x [app/[id]/page.tsx:3] y", 1)).toBeUndefined();
    expect(citeAt("[src/pages/[id].ts:3-9] tail")).toEqual({ path: "src/pages/[id].ts", line: 3, end: 9, raw: "[src/pages/[id].ts:3-9]" });
  });

  it("renders bracketed citations as chips inside markdown, and keeps path links as links", () => {
    expect(parseInline("Loads it [app/[id]/page.tsx:3].").map((n) => n.t)).toEqual(["text", "cite", "text"]);
    expect(parseInline("Read [docs/a.md](docs/a.md) first.").map((n) => n.t)).toEqual(["text", "link", "text"]);
    expect(parseInline("Not here `[src/a.ts:3]`.").map((n) => n.t)).toEqual(["text", "code", "text"]);
    expect(citeLabel(citeAt("[pages/alerts/[[...params]].tsx:175-185]")!)).toBe("[[...params]].tsx:175–185");
    expect(citeLabel(citeAt("[app/[slug]/page.tsx]")!)).toBe("page.tsx");
    expect(stripCites("Lists alerts [pages/[[...params]].tsx:1]. Done [app/(g)/page.tsx:2].")).toBe("Lists alerts. Done.");
  });

  it("splits sentences after a bracketed citation, so the next one must cite too", () => {
    expect(splitSentences("Shows one item. [app/[id]/page.tsx:3] Then it lists all. [pages/[[...p]].tsx:4]")).toEqual([
      "Shows one item. [app/[id]/page.tsx:3]",
      "Then it lists all. [pages/[[...p]].tsx:4]",
    ]);
    expect(uncitedSentences("Shows one item. [app/[id]/page.tsx:3] It also emails a receipt to the customer.")).toEqual([
      "It also emails a receipt to the customer.",
    ]);
  });
});

describe("chat actions are named by their question", () => {
  const questions = ["How is an order paid?", "Who can cancel an order?", "Where are refunds stored?"];
  const visible: Record<TurnAction, string | undefined> = {
    followUp: undefined,
    showOnMap: "chat.showOnMap",
    escalate: "chat.escalate",
    retry: "chat.retry",
    dismiss: "ask.dismiss",
  };

  for (const lang of ["en", "fr"] as const) {
    it(`gives the follow-up chips distinct names holding the question (${lang})`, () => {
      setLang(lang);
      const names = questions.map((q) => turnActionName("followUp", q));
      expect(new Set(names).size).toBe(questions.length);
      names.forEach((name, i) => expect(name).toContain(questions[i]));
      expect(names[0]).toBe(lang === "en" ? "Ask: How is an order paid?" : "Demander : How is an order paid?");
    });

    it(`names every per-turn action after its visible label and its question (${lang})`, () => {
      setLang(lang);
      for (const [action, key] of Object.entries(visible) as [TurnAction, string | undefined][]) {
        const names = questions.map((q) => turnActionName(action, q));
        expect(new Set(names).size, action).toBe(questions.length);
        names.forEach((name, i) => {
          expect(name, action).toContain(questions[i]);
          if (key) expect(name.startsWith(t(key)), `${action}: ${name}`).toBe(true); // label in name (WCAG 2.5.3)
        });
      }
    });
  }
});
