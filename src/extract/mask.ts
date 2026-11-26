// Comment (and optionally string) masking shared by every extractor: blank
// out what is not code, keep every offset and line number where it was.
//
// An extractor that pattern-matches source must never match inside a comment —
// `// app.get("/old", …)` is a route that does not exist. Blanking (each
// character becomes a space, newlines stay) rather than deleting keeps any
// match's offset, and so its line, true: facts cite the real `[path:line]`.
//
// Two views of a file, same offsets:
//   maskComments(text, syntax)                    comments blanked, strings kept
//                                                 (route paths live in them);
//   maskComments(text, syntax, { strings: true }) string CONTENTS blanked too,
//                                                 quotes kept — a skeleton to
//                                                 search for call sites, so a
//                                                 log message "app.get('/x')"
//                                                 is not a route.
// Search the skeleton, read literals from the comment-masked text.
//
// The vendored codeindex engine lexes comments internally but exports no
// masking helper, so this lives here; it is pure and can move upstream as is.

export type CommentSyntax = "js" | "c" | "python" | "hash";

export interface MaskOptions {
  /** Also blank the contents of string literals (delimiters kept). Template substitutions stay code. */
  strings?: boolean;
}

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const C_EXT = new Set([
  ".prisma",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rs",
  ".dart",
  ".proto",
  ".graphql",
  ".gql",
]);
const PY_EXT = new Set([".py", ".pyi"]);
const HASH_EXT = new Set([".yml", ".yaml", ".toml", ".sh", ".bash", ".zsh", ".rb", ".tf", ".cfg", ".ini", ".conf", ".env"]);

/** Lower-cased extension of a path, with the dot (`.ts`); "" when none. */
export function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** The comment syntax of a file, from its extension (Dockerfiles by name); undefined when unknown. */
export function commentSyntaxFor(rel: string): CommentSyntax | undefined {
  const ext = extOf(rel);
  if (JS_EXT.has(ext)) return "js";
  if (C_EXT.has(ext)) return "c";
  if (PY_EXT.has(ext)) return "python";
  if (HASH_EXT.has(ext)) return "hash";
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (/^(?:Dockerfile|Containerfile)(?:\..+)?$/.test(base) || ext === ".dockerfile") return "hash";
  return undefined;
}

/** Blank comments in `text` (offset- and line-preserving). Unknown syntax returns the text unchanged. */
export function maskComments(text: string, syntax: CommentSyntax | undefined, opts: MaskOptions = {}): string {
  const strings = opts.strings === true;
  switch (syntax) {
    case "js":
      return maskCLike(text, true, strings);
    case "c":
      return maskCLike(text, false, strings);
    case "python":
      return maskPython(text, strings);
    case "hash":
      return maskHash(text, strings);
    default:
      return text;
  }
}

/** Convenience: mask by path. */
export function maskSource(rel: string, text: string, opts: MaskOptions = {}): string {
  return maskComments(text, commentSyntaxFor(rel), opts);
}

/** A 1-based line lookup for character offsets, O(log n) per call. */
export function lineIndex(text: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function blank(out: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
}

const REGEX_PREV_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_PREV_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

/** Could a `/` at `i` start a regex literal, judging by the previous significant token? */
function regexAllowed(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j] as string)) j--;
  if (j < 0) return true;
  const ch = text[j] as string;
  if (REGEX_PREV_PUNCT.has(ch)) return true;
  if (/[\w$]/.test(ch)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(text[k] as string)) k--;
    return REGEX_PREV_WORD.has(text.slice(k + 1, j + 1));
  }
  return false;
}

/** End (exclusive) of a regex literal starting at `i`, or -1 when it does not close on this line. */
function regexEnd(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") {
      j++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "/") {
      let k = j + 1;
      while (k < text.length && /[a-z]/i.test(text[k] as string)) k++;
      return k;
    }
  }
  return -1;
}

function maskCLike(text: string, js: boolean, strings: boolean): string {
  const out = text.split("");
  const n = text.length;
  // Brace depth at which each open template `${` returns to its template body.
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const skipQuoted = (start: number, quote: string): number => {
    let j = start + 1;
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) {
        if (strings) blank(out, start + 1, j);
        return j + 1;
      }
      // An unterminated '…' or "…" ends at the line: JS strings cannot span
      // lines, and JSX text (`don't`) must not swallow the rest of the file.
      if (ch === "\n") {
        if (strings) blank(out, start + 1, j);
        return j;
      }
      j++;
    }
    if (strings) blank(out, start + 1, n);
    return n;
  };
  // Scan a template body from `start` (just after the backtick or the `}` that
  // closed a substitution). Returns the index after the closing backtick, or
  // the index just after `${` with the substitution pushed on the stack.
  const scanTemplate = (start: number): number => {
    let j = start;
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "`") {
        if (strings) blank(out, start, j);
        return j + 1;
      }
      if (ch === "$" && text[j + 1] === "{") {
        if (strings) blank(out, start, j);
        templates.push(depth);
        depth++;
        return j + 2;
      }
      j++;
    }
    if (strings) blank(out, start, n);
    return n;
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(out, i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const j = close === -1 ? n : close + 2;
      blank(out, i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(i, ch);
      continue;
    }
    if (js && ch === "`") {
      i = scanTemplate(i + 1);
      continue;
    }
    if (js && ch === "/" && regexAllowed(text, i)) {
      const end = regexEnd(text, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (js && ch === "{") depth++;
    else if (js && ch === "}") {
      depth--;
      if (templates.length && depth === templates[templates.length - 1]) {
        templates.pop();
        i = scanTemplate(i + 1);
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

function maskPython(text: string, strings: boolean): string {
  const out = text.split("");
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "#") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(out, i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (text.startsWith(ch.repeat(3), i)) {
        const close = text.indexOf(ch.repeat(3), i + 3);
        const j = close === -1 ? n : close + 3;
        // A triple-quoted string standing alone as a statement is a docstring:
        // documentation, so it is masked like a comment. One used as a value
        // (`sql = """…"""`) is data and is kept.
        let k = i - 1;
        while (k >= 0 && /[rRbBuUfF]/.test(text[k] as string)) k--;
        let s = k;
        while (s >= 0 && (text[s] === " " || text[s] === "\t")) s--;
        if (s < 0 || text[s] === "\n") blank(out, i, j);
        else if (strings) blank(out, i + 3, Math.max(i + 3, j - 3));
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== ch && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      if (strings) blank(out, i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

function maskHash(text: string, strings: boolean): string {
  const out = text.split("");
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    // `#` opens a comment at line start or after whitespace only: in YAML and
    // shell, `a#b` is a value, not a comment.
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1] as string))) {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(out, i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && text[j] !== ch && text[j] !== "\n") j += text[j] === "\\" && ch === '"' ? 2 : 1;
      if (strings) blank(out, i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}
