// Fact extents: the last line of the definition a fact's `line` starts, so a
// fact owns `[line, end]` and nothing past it (a hunk below the last route of
// a file is not that route's).
//
// Extractors that know the exact construct set `end` themselves (the closing
// parenthesis of an Express registration, a route table entry, a file-level
// page). Every other fact gets the extent of the statement its line starts,
// read from the masked source (comments and string contents blanked, so a
// bracket in either never counts):
//
//   js / c / json  the bracket-balanced statement from the start of the line:
//                  up to a `;` or `,` at depth 0, a closer of an enclosing
//                  bracket, or a line end where the statement is complete (no
//                  operator left dangling, the next line does not continue it
//                  with `.`, `?`, `:`, `=`, …). Decorators (`@Get()`,
//                  `@Entity()`) extend to the declaration they decorate; a
//                  chain link (`.get(h)`) stops before the next link.
//   sql            up to a `;` at depth 0 or a blank line.
//   python         the logical line (brackets balanced), decorators through
//                  to their `def` / `class`, and the indented block of a
//                  header ending with `:`.
//   yaml / hash    the logical line and every following line indented deeper.
//   other          the line itself.
//
// Pure and cheap: one masking pass per file, one forward scan per fact.

import { type CommentSyntax, commentSyntaxFor, extOf, maskComments } from "./mask.js";

/** Last line (1-based) of the definition starting on a given line. */
export type ExtentOf = (line: number) => number;

/** Where the scanning syntax differs from the masking one (JSON has no comments but C-like strings). */
function scanSyntax(rel: string): CommentSyntax | undefined {
  return commentSyntaxFor(rel) ?? (extOf(rel) === ".json" ? "c" : undefined);
}

/** Last line of `text` holding anything but whitespace (1 for an empty text). */
export function lastLine(text: string): number {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if ((lines[i] as string).trim()) return i + 1;
  return 1;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
/** A statement ending a line on one of these goes on (`=`, `=>`, `&&`, `.`, …). */
const CONT_PREV = new Set(["=", "+", "-", "*", "/", "%", "&", "|", "^", "!", "?", ":", "<", ">", ".", "("]);
/** A line starting with one of these continues the statement above. */
const CONT_NEXT = new Set([".", "?", ":", "=", "+", "*", "&", "|", "^", "%"]);

const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v";

/** Offsets of every line start, and a 1-based line lookup for offsets. */
function lineTable(text: string): { starts: number[]; lineOf: (offset: number) => number } {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { starts, lineOf };
}

/** Bracket-balanced statement scan from `start` (js / c / json / sql). Returns the offset of its last significant character, or -1. */
function scanStatement(sk: string, start: number, sql: boolean): number {
  let depth = 0;
  let segFirst = -1;
  let last = -1;
  for (let i = start; i < sk.length; i++) {
    const ch = sk[i] as string;
    if (isSpace(ch)) continue;
    if (ch === "\n") {
      if (depth !== 0 || segFirst === -1) continue;
      if (sql) {
        // A blank line ends a statement that forgot its `;`.
        let j = i + 1;
        while (isSpace(sk[j])) j++;
        if (sk[j] === "\n" || j >= sk.length) return last;
        continue;
      }
      const prev = sk[last] as string;
      const selfClosing = prev === ">" && sk[last - 1] === "/";
      if (CONT_PREV.has(prev) && !selfClosing) continue;
      let j = i + 1;
      while (j < sk.length && (isSpace(sk[j]) || sk[j] === "\n")) j++;
      const next = sk[j];
      if (next === undefined) return last;
      if (next === ".") {
        // A chain link (`.get(h)`) ends before the next link; anything else is continued by it.
        if (sk[segFirst] === ".") return last;
        continue;
      }
      if (CONT_NEXT.has(next)) continue;
      if (next === "{" && prev === ")") continue;
      // A decorator belongs to the declaration below it.
      if (sk[segFirst] === "@") {
        segFirst = -1;
        continue;
      }
      return last;
    }
    if (segFirst === -1) segFirst = i;
    if (OPEN.has(ch)) depth++;
    else if (CLOSE.has(ch)) {
      // The closer of a bracket opened before the fact: the enclosing literal ends here.
      if (depth === 0) return last;
      depth--;
    } else if (depth === 0 && (ch === ";" || (!sql && ch === ","))) return i;
    last = i;
  }
  return last;
}

/** Indentation-scoped extent (python, yaml / hash): logical line, decorators, then the deeper-indented block. */
function scanIndented(sk: string, starts: number[], line: number, python: boolean): number {
  const count = starts.length;
  const lineText = (l: number) => sk.slice(starts[l - 1] as number, l < count ? (starts[l] as number) - 1 : sk.length);
  const indentOf = (s: string) => s.length - s.trimStart().length;
  /** Last line of the logical line starting at `l` (brackets balanced, `\` continuations followed). */
  const logicalEnd = (l: number): number => {
    let depth = 0;
    for (let k = l; k <= count; k++) {
      const s = lineText(k);
      for (const ch of s) {
        if (OPEN.has(ch)) depth++;
        else if (CLOSE.has(ch)) depth--;
      }
      if (depth <= 0 && !s.trimEnd().endsWith("\\")) return k;
    }
    return count;
  };
  let header = line;
  let end = logicalEnd(header);
  // Decorators run down to the `def` / `class` they decorate.
  while (python && lineText(header).trimStart().startsWith("@") && end < count) {
    let k = end + 1;
    while (k <= count && !lineText(k).trim()) k++;
    if (k > count) break;
    header = k;
    end = logicalEnd(header);
  }
  if (python && !lineText(end).trimEnd().endsWith(":")) return end;
  const indent = indentOf(lineText(header));
  let last = end;
  for (let k = end + 1; k <= count; k++) {
    const s = lineText(k);
    if (!s.trim()) continue;
    if (indentOf(s) <= indent) break;
    last = k;
  }
  return last;
}

/**
 * The extent finder of one file: `line` → the last line of the definition
 * starting there (never before `line`, never past the file's last line).
 */
export function extentFinder(rel: string, text: string): ExtentOf {
  const syntax = scanSyntax(rel);
  if (syntax === undefined) return (line) => line;
  const sk = maskComments(text, syntax, { strings: true });
  const { starts, lineOf } = lineTable(sk);
  const cache = new Map<number, number>();
  return (line) => {
    const hit = cache.get(line);
    if (hit !== undefined) return hit;
    let end = line;
    if (line >= 1 && line <= starts.length) {
      if (syntax === "python" || syntax === "hash") end = scanIndented(sk, starts, line, syntax === "python");
      else {
        const last = scanStatement(sk, starts[line - 1] as number, syntax === "sql");
        if (last !== -1) end = lineOf(last);
      }
    }
    end = Math.max(line, end);
    cache.set(line, end);
    return end;
  };
}

/** Is every line of `[from, to]` blank once comments are masked (a blank-line or comment-only stretch)? */
export function blankOrCommentOnly(rel: string, text: string): (from: number, to: number) => boolean {
  const masked = maskComments(text, scanSyntax(rel));
  const lines = masked.split("\n");
  return (from, to) => {
    for (let l = Math.max(1, from); l <= Math.min(to, lines.length); l++) if ((lines[l - 1] as string).trim()) return false;
    return true;
  };
}
