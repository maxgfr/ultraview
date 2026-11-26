// Small JS/TS lexing helpers shared by the JavaScript-family extractors. They
// run on comment-masked text (see mask.ts), so they only have to respect
// strings and template literals.

export const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export function isJsLike(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) return false;
  return JS_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface Arg {
  /** The argument's source text, trimmed. */
  raw: string;
  /** Offset of the trimmed text in the file. */
  start: number;
}

/** Skip a quoted string or template literal starting at `i`; returns the index after it. */
export function skipString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  let braces = 0;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (quote === "`") {
      if (ch === "$" && text[j + 1] === "{") {
        braces++;
        j += 2;
        continue;
      }
      if (braces > 0) {
        if (ch === "{") braces++;
        else if (ch === "}") braces--;
        j++;
        continue;
      }
    } else if (ch === "\n") return j;
    if (ch === quote) return j + 1;
    j++;
  }
  return j;
}

/**
 * Split the arguments of the call whose `(` is at `open`. Returns undefined
 * when the parentheses never close (a truncated or malformed file).
 */
export function readArgs(text: string, open: number): { args: Arg[]; end: number } | undefined {
  const args: Arg[] = [];
  let depth = 0;
  let argStart = open + 1;
  const push = (to: number) => {
    const slice = text.slice(argStart, to);
    const lead = slice.length - slice.trimStart().length;
    const raw = slice.trim();
    if (raw) args.push({ raw, start: argStart + lead });
  };
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i) - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        push(i);
        return { args, end: i + 1 };
      }
    } else if (ch === "," && depth === 1) {
      push(i);
      argStart = i + 1;
    }
  }
  return undefined;
}

/** The value of a plain string literal (`"x"`, `'x'`, or a template without substitutions), else undefined. */
export function stringLiteral(raw: string): string | undefined {
  const m = /^(["'`])([\s\S]*)\1$/.exec(raw);
  if (!m) return undefined;
  const body = m[2] as string;
  if (m[1] === "`" && body.includes("${")) return undefined;
  if (body.includes(m[1] as string) && !body.includes("\\")) return undefined;
  return body;
}

/** A dotted identifier (`listOrders`, `controller.list`), else undefined. */
export function identifierPath(raw: string): string | undefined {
  return /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(raw) ? raw.replace(/\s+/g, "") : undefined;
}

function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Resolve a relative import specifier against the importing file, extension stripped. Undefined for bare specifiers. */
export function resolveRelative(fromRel: string, spec: string): string | undefined {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const joined = normalizePosix(`${dir}/${spec}`);
  return joined.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

/** The file a resolved, extension-less module path names, among `files`. */
export function moduleFile(target: string, files: ReadonlySet<string>): string | undefined {
  for (const ext of JS_EXTENSIONS) if (files.has(`${target}${ext}`)) return `${target}${ext}`;
  for (const ext of JS_EXTENSIONS) if (files.has(`${target}/index${ext}`)) return `${target}/index${ext}`;
  return undefined;
}

/**
 * Local names bound to relative imports: `import x from "./a"`,
 * `import { a as b } from "./a"`, `import * as n from "./a"`,
 * `const x = require("./a")`, `const { a, b: c } = require("./a")`.
 * Maps local name → specifier.
 */
export function relativeImports(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const IMPORT = /\bimport\s+(?:type\s+)?([\w$\s{},*]+?)\s+from\s+(["'])(\.{1,2}\/[^"']+)\2/g;
  for (const m of text.matchAll(IMPORT)) {
    const clause = m[1] as string;
    const spec = m[3] as string;
    const named = /\{([^}]*)\}/.exec(clause);
    const head = clause.replace(/\{[^}]*\}/, "").trim();
    for (const part of head.split(",")) {
      const p = part.trim();
      const star = /^\*\s+as\s+([\w$]+)$/.exec(p);
      if (star) out.set(star[1] as string, spec);
      else if (/^[\w$]+$/.test(p)) out.set(p, spec);
    }
    if (named) {
      for (const part of (named[1] as string).split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        if (!p) continue;
        const local = p
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (local && /^[\w$]+$/.test(local)) out.set(local, spec);
      }
    }
  }
  const REQUIRE = /\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(\s*(["'])(\.{1,2}\/[^"']+)\2\s*\)/g;
  for (const m of text.matchAll(REQUIRE)) {
    const binding = m[1] as string;
    const spec = m[3] as string;
    if (binding.startsWith("{")) {
      for (const part of binding.slice(1, -1).split(",")) {
        const local = part.split(":").pop()?.trim();
        if (local && /^[\w$]+$/.test(local)) out.set(local, spec);
      }
    } else out.set(binding, spec);
  }
  return out;
}

/** Does the file import or require the bare module `name` (or a subpath of it)? */
export function importsModule(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)["']${esc}(?:/[^"']*)?["']`).test(text);
}
