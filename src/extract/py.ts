// Small Python lexing helpers shared by the Python extractors. Like js.ts they
// run on comment-masked text (mask.ts blanks `#` comments and docstrings), so
// they only have to respect string literals. Call arguments are split with
// js.ts `readArgs`: Python's brackets and quotes balance the same way.

import type { Arg } from "./js.js";

export function isPython(rel: string): boolean {
  return rel.toLowerCase().endsWith(".py");
}

export interface PyString {
  value: string;
  /** An f-string: `{…}` substitutions are code, not text. */
  f: boolean;
}

/** The value of a Python string literal (`"x"`, `r'x'`, `f"x{y}"`, `"""x"""`), else undefined. */
export function pyString(raw: string): PyString | undefined {
  const m = /^([rRbBuUfF]{0,2})("""|'''|"|')([\s\S]*)\2$/.exec(raw);
  if (!m) return undefined;
  const quote = m[2] as string;
  const body = m[3] as string;
  if (quote.length === 1 && body.includes(quote) && !body.includes("\\")) return undefined;
  return { value: body, f: /f/i.test(m[1] as string) };
}

/** A plain (non-f) Python string literal's value, else undefined. */
export function pyLiteral(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const s = pyString(raw);
  return s && !s.f ? s.value : undefined;
}

const KWARG = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/;

/** The value of keyword argument `name` (`prefix="/x"` → `"/x"`), else undefined. */
export function kwarg(args: readonly Arg[], name: string): Arg | undefined {
  for (const a of args) {
    const m = KWARG.exec(a.raw);
    if (m && m[1] === name) {
      const value = m[2] as string;
      return { raw: value.trim(), start: a.start + a.raw.length - value.length };
    }
  }
  return undefined;
}

/** Positional arguments only (keyword and `*`/`**` unpacking arguments dropped). */
export function positional(args: readonly Arg[]): Arg[] {
  return args.filter((a) => !KWARG.test(a.raw) && !a.raw.startsWith("*"));
}

/** A dotted Python name (`views.list_orders`), else undefined. */
export function pyDotted(raw: string): string | undefined {
  return /^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*$/.test(raw) ? raw.replace(/\s+/g, "") : undefined;
}

/** The string items of a list / tuple / set literal (`["GET", "POST"]`), else undefined when any item is not a plain string. */
export function pyStringList(raw: string): string[] | undefined {
  const m = /^[[({]([\s\S]*)[\])}]$/.exec(raw.trim());
  if (!m) return undefined;
  const out: string[] = [];
  for (const part of (m[1] as string).split(",")) {
    const p = part.trim();
    if (!p) continue;
    const v = pyLiteral(p);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}

/** What a local name is bound to by an import: `import a.b as x` → { module: "a.b" }; `from a import b` → { module: "a", name: "b" }. */
export interface PyImport {
  module: string;
  name?: string;
}

/** Local names bound by the file's imports (absolute and relative). */
export function pyImports(text: string): Map<string, PyImport> {
  const out = new Map<string, PyImport>();
  const IMPORT = /^[ \t]*import[ \t]+([^\n]+)/gm;
  for (const m of text.matchAll(IMPORT)) {
    for (const part of (m[1] as string).split(",")) {
      const p = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (!p) continue;
      const module = p[1] as string;
      out.set(p[2] ?? (module.split(".")[0] as string), { module: p[2] ? module : (module.split(".")[0] as string) });
    }
  }
  const FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm;
  for (const m of text.matchAll(FROM)) {
    const module = m[1] as string;
    if (!module) continue;
    for (const part of (m[2] as string).replace(/[()]/g, "").split(",")) {
      const p = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part.replace(/\\\s*$/, ""));
      if (!p || p[1] === "*") continue;
      out.set(p[2] ?? (p[1] as string), { module, name: p[1] as string });
    }
  }
  return out;
}

/** Does the file import the top-level module `name` (`import name`, `import name.x`, `from name(.x) import …`)? */
export function importsPyModule(text: string, name: string): boolean {
  const esc = name.replace(/[.]/g, "\\.");
  return new RegExp(`^[ \\t]*(?:import[ \\t]+(?:[\\w.]+[ \\t]*,[ \\t]*)*${esc}(?:\\.[\\w.]+)?\\b|from[ \\t]+${esc}(?:\\.[\\w.]+)?[ \\t]+import\\b)`, "m").test(
    text,
  );
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/**
 * A module reference as a slash path without extension: relative modules
 * (`.routers`, `..core.db`) resolved against `fromRel`'s package, absolute ones
 * (`app.routers.orders`) converted as written (resolved later, see `pyModuleFile`).
 */
export function pyModulePath(fromRel: string, module: string): string {
  const dots = /^\.*/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots).split(".").filter(Boolean);
  if (!dots) return rest.join("/");
  let dir = dirOf(fromRel);
  for (let i = 1; i < dots; i++) dir = dirOf(dir);
  return [dir, ...rest].filter(Boolean).join("/");
}

/**
 * The module an imported name used as a mount target lives in, as `|`
 * alternatives for `MountHint.target`: `from app.routers import orders` +
 * `orders.router` → `app/routers/orders|app/routers` (a submodule first, else
 * the package that defines the object). Undefined for names not imported.
 */
export function pyImportTarget(fromRel: string, raw: string, imports: ReadonlyMap<string, PyImport>): string | undefined {
  const dotted = pyDotted(raw);
  if (!dotted) return undefined;
  const parts = dotted.split(".");
  const imp = imports.get(parts[0] as string);
  if (!imp) return undefined;
  const base = pyModulePath(fromRel, imp.module);
  if (imp.name !== undefined) {
    // `from F import N`: N is a submodule of F, or an object defined in F.
    const sub = [base, imp.name].filter(Boolean).join("/");
    return base ? `${sub}|${base}` : sub;
  }
  // `import a.b as x` then `x.router`, or `import a` then `a.b.router`: the module is everything but the attribute.
  const inner = parts.slice(1, -1);
  return [base, ...inner].filter(Boolean).join("/");
}

/**
 * The indexed file a Python module path names: `<root>/<target>.py` or
 * `<root>/<target>/__init__.py`, with `<root>` the repo root then each
 * ancestor directory of `fromRel` (src layouts, nested Django projects).
 */
export function pyModuleFile(target: string, fromRel: string, files: ReadonlySet<string>): string | undefined {
  const roots = [""];
  const segs = dirOf(fromRel).split("/").filter(Boolean);
  for (let i = 1; i <= segs.length; i++) roots.push(segs.slice(0, i).join("/"));
  for (const alt of target.split("|")) {
    if (!alt) continue;
    for (const root of roots) {
      const base = root ? `${root}/${alt}` : alt;
      if (files.has(`${base}.py`)) return `${base}.py`;
      if (files.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    }
  }
  return undefined;
}

/**
 * The function a decorator decorates, `from` being the offset just past the
 * decorator (its closing parenthesis, or its name when it takes no call):
 * skips the rest of that line and any further decorators, and returns the
 * `def` / `async def` name. `skeleton` is the string-masked view.
 */
export function decoratedName(skeleton: string, from: number): { name: string; offset: number } | undefined {
  const re = /\s*(?:@[\w.]+[ \t]*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?[^\n]*\n|(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*))/y;
  let at = skeleton.indexOf("\n", from);
  if (at === -1) return undefined;
  for (let guard = 0; guard < 20; guard++) {
    re.lastIndex = at;
    const m = re.exec(skeleton);
    if (!m) return undefined;
    if (m[2]) return { name: m[2], offset: m.index + m[0].length - m[2].length };
    at = re.lastIndex;
  }
  return undefined;
}

export interface PyClass {
  name: string;
  /** Offset of the `class` keyword. */
  offset: number;
  /** Base-class arguments, as written. */
  bases: Arg[];
  /** Body statements at the body's own indentation: offset of each statement's first character. */
  statements: number[];
}

function indentAt(text: string, lineStart: number): number {
  let i = lineStart;
  while (text[i] === " " || text[i] === "\t") i++;
  return i - lineStart;
}

/**
 * Every class of the file, with its bases and the offsets of its direct body
 * statements. `skeleton` (strings blanked) decides structure; `readBases` reads
 * the base list from the comment-masked text at the same offsets.
 */
export function pyClasses(skeleton: string, readBases: (open: number) => Arg[] | undefined): PyClass[] {
  const out: PyClass[] = [];
  const CLASS = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*(\(|:)/gm;
  for (const m of skeleton.matchAll(CLASS)) {
    const indent = (m[1] as string).length;
    const offset = (m.index as number) + indent;
    let headerEnd = (m.index as number) + m[0].length;
    let bases: Arg[] = [];
    if (m[3] === "(") {
      const open = headerEnd - 1;
      bases = readBases(open) ?? [];
      let depth = 0;
      for (let i = open; i < skeleton.length; i++) {
        if (skeleton[i] === "(") depth++;
        else if (skeleton[i] === ")" && --depth === 0) {
          headerEnd = i + 1;
          break;
        }
      }
    }
    const nl = skeleton.indexOf("\n", headerEnd);
    const statements: number[] = [];
    if (nl !== -1) {
      let bodyIndent = -1;
      let at = nl + 1;
      while (at < skeleton.length) {
        const end = skeleton.indexOf("\n", at);
        const lineEnd = end === -1 ? skeleton.length : end;
        const line = skeleton.slice(at, lineEnd);
        if (line.trim()) {
          const ind = indentAt(skeleton, at);
          if (ind <= indent) break;
          if (bodyIndent === -1) bodyIndent = ind;
          if (ind === bodyIndent) statements.push(at + ind);
        }
        if (end === -1) break;
        at = end + 1;
      }
    }
    out.push({ name: m[2] as string, offset, bases, statements });
  }
  return out;
}

/** Python route params to the `:name` form: `{id}` / `{p:path}` (FastAPI), `<id>` / `<int:id>` (Flask, Django). */
export function pyRouteParams(path: string): string {
  return path.replace(/\{([A-Za-z_]\w*)(?::[^}]*)?\}/g, ":$1").replace(/<(?:[A-Za-z_]\w*:)?([A-Za-z_]\w*)>/g, ":$1");
}
