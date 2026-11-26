// The markdown subset lens answers, summaries and notes use: paragraphs,
// bullet and numbered lists, headings, `inline code`, **bold**, *emphasis*,
// [links](https://…) and citations [path:line] / [path:10-12] (lib/cite.ts).
//
// Parsed into a small tree that the UI turns into elements — never into an
// HTML string — so text is always text: `<script>` stays literal, and a link
// only keeps an href that passes `safeHref` (http, https, mailto, in-page
// anchors and plain relative paths). Anything else renders as its text.

import { citationAt, citationLines, stripNonProse } from "./cite.js";

/** A citation as the viewer draws it: `raw` is the whole token, brackets included. */
export interface CiteRef {
  path: string;
  /** Absent for a whole-file citation (`[src/app/[id]/page.tsx]`). */
  line?: number;
  end?: number;
  raw: string;
}

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "cite"; cite: CiteRef };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] };

/**
 * A citation at the start of `s`, if one is there: the gates' grammar
 * (lib/cite.ts), so `[app/[id]/page.tsx:3]`, `[pages/[[...params]].tsx:175-185]`,
 * `[src/(shop)/+page.svelte:2]` and `[src/a.ts]` are all chips. A bare name
 * without a slash is a chip only as `name.ext:line` without spaces: the engine
 * only checks those when such a file exists (`[Node.js]` is no citation), and
 * the viewer cannot tell.
 */
export function citeAt(s: string): CiteRef | undefined {
  const hit = citationAt(s);
  if (!hit) return undefined;
  const { path, start, end } = citationLines(hit.citation);
  if (!path.includes("/") && (start === undefined || /\s/.test(path))) return undefined;
  return {
    path,
    ...(start !== undefined ? { line: start } : {}),
    ...(end !== undefined && end !== start ? { end } : {}),
    raw: s.slice(0, hit.length),
  };
}

/** The citations of `text` with where they start, skipping code and comments as the engine does. */
function citesIn(text: string): { at: number; cite: CiteRef }[] {
  const prose = stripNonProse(text);
  const out: { at: number; cite: CiteRef }[] = [];
  for (let i = prose.indexOf("["); i !== -1; ) {
    const cite = citeAt(text.slice(i));
    if (cite) out.push({ at: i, cite });
    i = prose.indexOf("[", i + (cite ? cite.raw.length : 1));
  }
  return out;
}

/** Every citation in a piece of prose, in order (one per chip). */
export function parseCites(text: string): CiteRef[] {
  return citesIn(text).map((c) => c.cite);
}

/** Parse `path:line` / `path:10-12` (a node's `at`, a model edge's `cite`). */
export function parseLocation(s: string): CiteRef | undefined {
  return citeAt(`[${s}]`);
}

/** The href a link may carry, or undefined when it is not safe to follow. */
export function safeHref(url: string): string | undefined {
  // Browsers ignore control characters and whitespace inside a scheme: strip them before judging it.
  let cleaned = "";
  for (const ch of url) {
    const code = ch.codePointAt(0) as number;
    if (code > 0x20 && (code < 0x7f || code > 0x9f)) cleaned += ch;
  }
  if (!cleaned || /["'<>`\\]/.test(cleaned)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (scheme) {
    const s = (scheme[1] as string).toLowerCase();
    return s === "http" || s === "https" || s === "mailto" ? cleaned : undefined;
  }
  if (cleaned.startsWith("//")) return undefined;
  return cleaned;
}

function pushText(out: Inline[], v: string): void {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Find the closing `]` of a `[` at `open`, honouring nesting; -1 if none. */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    pushText(out, text);
    text = "";
  };
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === "\\" && i + 1 < s.length && /[\\`*_[\]()#+\-.!]/.test(s[i + 1] as string)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "*" && s[i + 1] === "*" && depth < 4) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(s.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] !== ch && s[i + 1] !== " " && depth < 4) {
      const end = s.indexOf(ch, i + 1);
      const prev = i === 0 ? " " : (s[i - 1] as string);
      if (end > i + 1 && s[end - 1] !== " " && (ch === "*" || /[\s(]/.test(prev))) {
        flush();
        out.push({ t: "em", c: parseInline(s.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const cite = citeAt(s.slice(i));
      // A path without a line followed by `(href)` is a link's label (`[docs/a.md](docs/a.md)`).
      if (cite && (cite.line !== undefined || s[i + cite.raw.length] !== "(")) {
        flush();
        out.push({ t: "cite", cite });
        i += cite.raw.length;
        continue;
      }
      const close = closeBracket(s, i);
      if (close !== -1 && s[close + 1] === "(" && depth < 4) {
        const end = s.indexOf(")", close + 2);
        if (end !== -1) {
          const label = s.slice(i + 1, close);
          const href = safeHref(s.slice(close + 2, end).trim());
          flush();
          if (href) out.push({ t: "link", href, c: parseInline(label, depth + 1) });
          else for (const n of parseInline(label, depth + 1)) n.t === "text" ? pushText(out, n.v) : out.push(n);
          i = end + 1;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { t: "ul" | "ol"; start: number; items: string[] } | undefined;
  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ").trim()) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it) => parseInline(it.trim()));
      blocks.push(list.t === "ul" ? { t: "ul", items } : { t: "ol", start: list.start, items });
    }
    list = undefined;
  };
  for (const line of lines) {
    const ul = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/.exec(line);
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      blocks.push({ t: "h", level: (h[1] as string).length, c: parseInline(h[2] as string) });
    } else if (ul) {
      flushPara();
      if (list?.t !== "ul") {
        flushList();
        list = { t: "ul", start: 1, items: [] };
      }
      list.items.push(ul[1] as string);
    } else if (ol) {
      flushPara();
      if (list?.t !== "ol") {
        flushList();
        list = { t: "ol", start: Number(ol[1]), items: [] };
      }
      list.items.push(ol[2] as string);
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/** The basename-and-line label of a citation chip (`orders.ts:12`, `orders.ts:10–12`). */
export function citeLabel(c: CiteRef): string {
  const base = c.path.split("/").pop() || c.path;
  return c.line === undefined ? base : `${base}:${c.line}${c.end ? `–${c.end}` : ""}`;
}

/** A citation's full location (`src/a.ts:10-12`, `src/a.ts` for a whole file). */
export function citeWhere(c: Pick<CiteRef, "path" | "line" | "end">): string {
  return `${c.path}${c.line !== undefined ? `:${c.line}` : ""}${c.line !== undefined && c.end ? `-${c.end}` : ""}`;
}

/** Prose with its citations taken out (for one-line previews). */
export function stripCites(text: string): string {
  let out = "";
  let from = 0;
  for (const { at, cite } of citesIn(text)) {
    out += text.slice(from, at);
    from = at + cite.raw.length;
  }
  out += text.slice(from);
  return out
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
