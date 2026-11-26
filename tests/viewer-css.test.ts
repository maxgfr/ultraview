// The viewer's layout invariants, read from viewer/styles.css (issue #25): the
// page itself never scrolls, every scroll container is the containing block of
// what is absolutely positioned inside it (an .sr-only label deep in a long
// list must not stretch the document), and a narrow-screen override is never
// undone by a base rule that comes after it. Runs in node: a small parser over
// the stylesheet, no DOM.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Rule {
  selectors: string[];
  decls: Map<string, string>;
  /** The enclosing @media prelude, or "" at the top level. */
  media: string;
  /** Source order. */
  at: number;
}

/** Style rules, top level and one level of @media (the stylesheet nests no deeper); @keyframes are skipped. */
function parseCss(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const decls = (body: string) => {
    const m = new Map<string, string>();
    for (const d of body.split(";")) {
      const i = d.indexOf(":");
      if (i > 0) m.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    return m;
  };
  /** The index just past the "}" matching the "{" at `open`. */
  const close = (open: number) => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return i + 1;
    }
    throw new Error("unbalanced braces in styles.css");
  };
  const walk = (from: number, to: number, media: string) => {
    let i = from;
    while (i < to) {
      const open = src.indexOf("{", i);
      if (open === -1 || open >= to) break;
      const prelude = src.slice(i, open).trim();
      const end = close(open);
      if (prelude.startsWith("@media")) walk(open + 1, end - 1, prelude);
      else if (!prelude.startsWith("@")) {
        const selectors = prelude.split(",").map((s) => s.trim().replace(/\s+/g, " "));
        rules.push({ selectors, decls: decls(src.slice(open + 1, end - 1)), media, at: rules.length });
      }
      i = end;
    }
  };
  walk(0, src.length, "");
  return rules;
}

const rules = parseCss(readFileSync(join(import.meta.dirname, "../viewer/styles.css"), "utf8"));
const base = rules.filter((r) => r.media === "");

/** What the base (media-free) rules declare for `selector`, later rules winning. */
function declared(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of base) if (r.selectors.includes(selector)) for (const [k, v] of r.decls) out.set(k, v);
  return out;
}

const scrolls = (v: string | undefined) => v !== undefined && /\b(auto|scroll)\b/.test(v);

describe("viewer layout (styles.css)", () => {
  it("parses the stylesheet", () => {
    expect(base.length).toBeGreaterThan(100);
    expect(rules.some((r) => r.media.includes("max-width: 599px"))).toBe(true);
  });

  it("locks the page to the viewport: html and body never scroll", () => {
    for (const sel of ["html", "body"]) {
      const d = declared(sel);
      expect(d.get("height"), sel).toBe("100%");
      expect(d.get("overflow"), sel).toBe("hidden");
    }
    for (const sel of ["#app", ".app"]) expect(declared(sel).get("height"), sel).toBe("100%");
    // Nothing inside the shell is sized against the viewport's height (it would overflow under the top bar).
    for (const r of base) for (const [k, v] of r.decls) if (k === "height") expect(v, r.selectors.join(", ")).not.toMatch(/\d(d|s|l)?vh\b/);
  });

  it("every scroll container is a containing block", () => {
    const containers = new Set<string>();
    for (const r of rules)
      if (scrolls(r.decls.get("overflow")) || scrolls(r.decls.get("overflow-y")) || scrolls(r.decls.get("overflow-x")))
        for (const s of r.selectors) containers.add(s);
    expect(containers).toContain(".panel-body");
    expect(containers).toContain(".chat-thread");
    const loose = [...containers].filter((s) => (declared(s).get("position") ?? "static") === "static");
    expect(loose).toEqual([]);
  });

  it(".sr-only is the standard visually-hidden pattern", () => {
    const d = declared(".sr-only");
    expect(Object.fromEntries(d)).toMatchObject({
      position: "absolute",
      width: "1px",
      height: "1px",
      margin: "-1px",
      padding: "0",
      overflow: "hidden",
      "white-space": "nowrap",
      border: "0",
    });
    expect(d.get("clip") ?? d.get("clip-path")).toBeTruthy();
  });

  it("a narrow-screen override is not undone by a later base rule", () => {
    const undone: string[] = [];
    for (const m of rules.filter((r) => /max-width/.test(r.media)))
      for (const sel of m.selectors)
        for (const prop of m.decls.keys())
          if (base.some((b) => b.at > m.at && b.selectors.includes(sel) && b.decls.has(prop))) undone.push(`${m.media} ${sel} { ${prop} }`);
    expect(undone).toEqual([]);
  });

  it("below 600 px the side panel and the chat cover the screen", () => {
    const narrow = rules.filter((r) => r.media.includes("max-width: 599px"));
    for (const sel of [".panel", ".chat"]) {
      const d = new Map<string, string>();
      for (const r of narrow) if (r.selectors.includes(sel)) for (const [k, v] of r.decls) d.set(k, v);
      expect(d.get("position"), sel).toBe("absolute");
      expect(d.get("inset"), sel).toBe("0");
      expect(d.get("width"), sel).toBe("auto");
      expect(d.get("max-width"), sel).toBe("none");
    }
  });
});
