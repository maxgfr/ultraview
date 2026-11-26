// The citation grammar of the gates, in the viewer: a mirror of ultraindex's
// `parseCitations` (src/vendor/ultraindex-engine.mjs, `src/cite.ts` there), so
// every citation `ultraview check` / `lens save` accepted is one the viewer
// can draw. Pure: no DOM, no engine import (the engine is node-only).
//
// A citation is a bracketed path with an optional line or line range:
// `[path]`, `[path:line]`, `[path:start-end]`. The path may itself hold up to
// two levels of brackets (`app/[id]/page.tsx`, `pages/[[...params]].tsx`) when
// it ends in a file extension; parentheses, `+`, `@`, dots and spaces are
// plain path characters. Trailing `.`, `,` and `;` inside the brackets are
// dropped. tests/viewer-cite.test.ts holds the parity table against the engine.

/** One citation, in the engine's shape: `raw` is the text inside the brackets, trimmed. */
export interface Citation {
  raw: string;
  path: string;
  start?: number;
  end?: number;
}

// Kept character for character with the engine's EXT_TOKEN / SIMPLE_TOKEN / LINE_SUFFIX.
const EXT_SOURCE = String.raw`\[((?:[^[\]\n]|\[(?:[^[\]\n]|\[[^\]\n]*\])*\])*?\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?)\]`;
const SIMPLE_SOURCE = String.raw`\[([^[\]\n]+)\]`;
const LINE_SUFFIX = /:(\d+)(?:-(\d+))?$/;
const EXT_AT = new RegExp(EXT_SOURCE, "y");
const SIMPLE_AT = new RegExp(SIMPLE_SOURCE, "y");
// The viewer's one leniency: a range with a typographic dash (see `citationLines`).
const EXT_DASH_AT = new RegExp(EXT_SOURCE.replace(String.raw`(?:-\d+)?`, String.raw`(?:\s*[-–—]\s*\d+)?`), "y");

/** The engine's test for "this bracketed text is a path": a slash, or a file extension. */
export function looksLikePath(s: string): boolean {
  return /\//.test(s) || /\.[A-Za-z0-9]{1,8}(:\d|$)/.test(s);
}

/** Text the engine does not read citations in (comments, code, non-path link labels), blanked to spaces. */
export function stripNonProse(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/~~~[\s\S]*?~~~/g, blank)
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, (m, label: string) => (looksLikePath(label.trim()) ? m : " ".repeat(m.length)));
}

/** A bracket's inner text as a citation, or undefined when it is not a path. */
function toCitation(inner: string): Citation | undefined {
  const raw = inner.trim().replace(/[.,;]+$/, "");
  if (!looksLikePath(raw)) return undefined;
  const ls = LINE_SUFFIX.exec(raw);
  if (!ls) return raw ? { raw, path: raw } : undefined;
  const path = raw.slice(0, ls.index);
  if (!path) return undefined;
  return { raw, path, start: Number(ls[1]), ...(ls[2] !== undefined ? { end: Number(ls[2]) } : {}) };
}

/** Every citation of `text`, deduplicated, in the engine's order: exactly `parseCitations` of ultraindex. */
export function parseCitations(text: string): Citation[] {
  const prose = stripNonProse(text);
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const source of [EXT_SOURCE, SIMPLE_SOURCE]) {
    for (const m of prose.matchAll(new RegExp(source, "g"))) {
      const c = toCitation(m[1] as string);
      if (!c || seen.has(c.raw)) continue;
      seen.add(c.raw);
      out.push(c);
    }
  }
  return out;
}

/**
 * The citation token starting at `s[at]` (a `[`), and how many characters it
 * spans, brackets included — the reading a renderer walking the text needs.
 * The engine's readings come first: a path with brackets inside
 * (`[app/[id]/page.tsx:3]`), else a flat one; then the same with a
 * typographic dash in its range (`[app/[id]/page.tsx:3–5]`).
 */
export function citationAt(s: string, at = 0): { citation: Citation; length: number } | undefined {
  if (s[at] !== "[") return undefined;
  for (const re of [EXT_AT, SIMPLE_AT, EXT_DASH_AT]) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) continue;
    const citation = toCitation(m[1] as string);
    if (citation) return { citation, length: m[0].length };
  }
  return undefined;
}

/**
 * The line range of a citation, tolerating a typographic dash or a spaced
 * hyphen: the engine reads `[a.ts:3–5]` as the path `a.ts:3–5`, which the
 * gate then rejects as a dead citation, so such a range never comes out of a
 * check; the viewer still reads it as lines 3 to 5 rather than as a file.
 */
export function citationLines(c: Citation): { path: string; start?: number; end?: number } {
  if (c.start !== undefined) return { path: c.path, start: c.start, ...(c.end !== undefined ? { end: c.end } : {}) };
  const dash = /^(.+?):(\d+)\s*[-–—]\s*(\d+)$/.exec(c.path);
  if (dash) return { path: dash[1] as string, start: Number(dash[2]), end: Number(dash[3]) };
  return { path: c.path };
}
