// Source views and module helpers shared by the JS/TS web extractors (routes,
// calls, screens, ORMs): masked views of JS files and of the <script> blocks
// of Vue / Svelte components, workspace-relative paths, import bindings with
// alias resolution, exported names, object literals, call chains and
// decorated classes. All pure: text and the repo context in, values out.

import { type Arg, isJsLike, moduleFile, readArgs, resolveRelative, stringLiteral } from "./js.js";
import { extOf, lineIndex, type MaskOptions, maskComments, maskSource } from "./mask.js";
import type { ExtractInput, RepoContext } from "./types.js";

const SFC_EXTENSIONS = new Set([".vue", ".svelte"]);

/** A JS-like file or a Vue / Svelte single-file component (whose <script> blocks are code). */
export function isScriptFile(rel: string): boolean {
  return isJsLike(rel) || SFC_EXTENSIONS.has(extOf(rel));
}

/**
 * Mask a file for searching. JS files: `maskSource`. Vue / Svelte components:
 * everything outside <script> blocks is blanked first (offsets and lines
 * kept), then the script is masked as JS. Other files: unchanged.
 */
export function maskScript(rel: string, text: string, opts: MaskOptions = {}): string {
  if (!SFC_EXTENSIONS.has(extOf(rel))) return maskSource(rel, text, opts);
  const out = text.replace(/[^\n\r]/g, " ").split("");
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const start = (m.index as number) + m[0].indexOf(">") + 1;
    const body = m[1] as string;
    for (let i = 0; i < body.length; i++) out[start + i] = body[i] as string;
  }
  return maskComments(out.join(""), "js", opts);
}

/** The two views every extractor searches, plus a line lookup. Same offsets in all. */
export interface SourceViews {
  /** Comments blanked, string literals kept: read values here. */
  text: string;
  /** Comments and string contents blanked: search call sites here. */
  skeleton: string;
  lineOf: (offset: number) => number;
  /** The raw text the views were computed from. */
  source: string;
}

const VIEWS = new WeakMap<ExtractInput, SourceViews>();

/** The views of a file, computed once per input: `runExtractors` hands every extractor the same input object. */
export function sourceViews(input: ExtractInput): SourceViews {
  const hit = VIEWS.get(input);
  if (hit && hit.source === input.text) return hit;
  const text = maskScript(input.rel, input.text);
  const views = { text, skeleton: maskScript(input.rel, input.text, { strings: true }), lineOf: lineIndex(text), source: input.text };
  VIEWS.set(input, views);
  return views;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/** The workspace (manifest directory, "" = root) a file belongs to: the nearest ancestor with a manifest. */
export function workspaceDirOf(ctx: RepoContext, rel: string): string {
  let dir = dirOf(rel);
  for (;;) {
    if (ctx.deps.has(dir)) return dir;
    if (dir === "") return "";
    dir = dirOf(dir);
  }
}

/** `rel` relative to its workspace directory. */
export function workspaceRelative(ctx: RepoContext, rel: string): { ws: string; sub: string } {
  const ws = workspaceDirOf(ctx, rel);
  return { ws, sub: ws ? rel.slice(ws.length + 1) : rel };
}

/** Does the workspace of `rel` declare one of `names`? A name ending in `/` matches a scope or prefix (`@remix-run/`). */
export function declares(ctx: RepoContext, rel: string, names: readonly string[]): boolean {
  const deps = ctx.depsFor(rel);
  for (const n of names) {
    if (n.endsWith("/")) {
      for (const d of deps) if (d.startsWith(n)) return true;
    } else if (deps.has(n)) return true;
  }
  return false;
}

const FILE_SETS = new WeakMap<readonly string[], Set<string>>();

function fileSetOf(ctx: RepoContext): Set<string> {
  let set = FILE_SETS.get(ctx.files);
  if (!set) FILE_SETS.set(ctx.files, (set = new Set(ctx.files)));
  return set;
}

/** An import specifier naming a module of the repo (relative, or a project alias such as `@/`, `~/`, `#`, `$lib`). */
export function isLocalSpecifier(spec: string): boolean {
  return /^(?:\.{1,2}\/|@\/|~~?\/|#|\$lib(?:\/|$))/.test(spec);
}

const STRIP_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The repo file a local import specifier names, among the indexed files.
 * Relative specifiers resolve against the importing file; aliases (`@/x`,
 * `~/x`, `~~/x`, `#x`, `$lib/x`) against the workspace root, its `src/` and
 * (Nuxt 4) its `app/`. Undefined for packages and unresolvable paths.
 */
export function resolveLocalModule(ctx: RepoContext, fromRel: string, spec: string): string | undefined {
  const files = fileSetOf(ctx);
  const tryTarget = (target: string): string | undefined => {
    if (files.has(target) && isScriptFile(target)) return target;
    return moduleFile(target.replace(STRIP_EXT, ""), files);
  };
  const rel = resolveRelative(fromRel, spec);
  if (rel !== undefined) return tryTarget(rel);
  if (!isLocalSpecifier(spec)) return undefined;
  const ws = workspaceDirOf(ctx, fromRel);
  const join = (dir: string, p: string) => (dir ? `${dir}/${p}` : p);
  let rest: string;
  let roots: string[];
  if (spec.startsWith("$lib")) {
    rest = spec.slice(4).replace(/^\//, "");
    roots = [join(ws, "src/lib")];
  } else {
    rest = spec.replace(/^(?:@\/|~~?\/|#\/?)/, "");
    roots = [join(ws, "src"), ws, join(ws, "app")];
  }
  for (const root of roots) {
    const hit = tryTarget(root ? (rest ? `${root}/${rest}` : root) : rest);
    if (hit) return hit;
  }
  return undefined;
}

/** A module path without extension, as `MountHint.target` expects (`moduleFile` adds it back). */
export function moduleTarget(file: string): string {
  return file.replace(STRIP_EXT, "");
}

export interface ImportBinding {
  spec: string;
  /** `default`, `*` (namespace), or the imported export name. */
  imported: string;
}

/**
 * Every import binding of a file, packages included: local name → specifier
 * and imported name. ES imports (default, named with `as`, namespace) and
 * `require` (whole module = `default`, destructured = named).
 */
export function importBindings(text: string): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  const IMPORT = /\bimport\s+(?:type\s+)?([\w$\s{},*]+?)\s+from\s*(["'])([^"'\n]+)\2/g;
  for (const m of text.matchAll(IMPORT)) {
    const clause = m[1] as string;
    const spec = m[3] as string;
    const named = /\{([^}]*)\}/.exec(clause);
    const head = clause.replace(/\{[^}]*\}/, "").trim();
    for (const part of head.split(",")) {
      const p = part.trim();
      const star = /^\*\s+as\s+([\w$]+)$/.exec(p);
      if (star) out.set(star[1] as string, { spec, imported: "*" });
      else if (/^[\w$]+$/.test(p)) out.set(p, { spec, imported: "default" });
    }
    if (named) {
      for (const part of (named[1] as string).split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        if (!p) continue;
        const [imported, local] = p.split(/\s+as\s+/).map((x) => x.trim());
        const name = local ?? imported;
        if (imported && name && /^[\w$]+$/.test(name)) out.set(name, { spec, imported });
      }
    }
  }
  const REQUIRE = /\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(\s*(["'])([^"'\n]+)\2\s*\)/g;
  for (const m of text.matchAll(REQUIRE)) {
    const binding = m[1] as string;
    const spec = m[3] as string;
    if (binding.startsWith("{")) {
      for (const part of binding.slice(1, -1).split(",")) {
        const [imported, local] = part.split(":").map((x) => x.trim());
        const name = local ?? imported;
        if (imported && name && /^[\w$]+$/.test(name)) out.set(name, { spec, imported });
      }
    } else out.set(binding, { spec, imported: "default" });
  }
  return out;
}

/** Local names bound to `imported` (default `default`) of package `pkg` (or one of its subpaths). */
export function namesImportedFrom(bindings: Map<string, ImportBinding>, pkg: string, imported = "default"): string[] {
  const out: string[] = [];
  for (const [local, b] of bindings) {
    if ((b.spec === pkg || b.spec.startsWith(`${pkg}/`)) && b.imported === imported) out.push(local);
  }
  return out.sort();
}

export interface ExportedName {
  /** The exported name (`GET`, `loader`). */
  name: string;
  /** The local binding behind it (`handler` in `export { handler as GET }`). */
  local: string;
  offset: number;
}

/** Names a module exports, by declaration or export list (re-exports included). Search the skeleton. */
export function exportedNames(skeleton: string): ExportedName[] {
  const out: ExportedName[] = [];
  for (const m of skeleton.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    out.push({ name: m[1] as string, local: m[1] as string, offset: m.index as number });
  }
  for (const m of skeleton.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    out.push({ name: m[1] as string, local: m[1] as string, offset: m.index as number });
  }
  for (const m of skeleton.matchAll(/\bexport\s+(?:const|let|var)\s+\{([^}]*)\}\s*=/g)) {
    for (const part of (m[1] as string).split(",")) {
      const [key, value] = part.split(":").map((x) => x.trim());
      const name = value ?? key;
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.push({ name, local: name, offset: m.index as number });
    }
  }
  for (const m of skeleton.matchAll(/\bexport\s+\{([^}]*)\}/g)) {
    for (const part of (m[1] as string).split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      const [local, name] = p.split(/\s+as\s+/).map((x) => x.trim());
      const exported = name ?? local;
      if (local && exported && /^[A-Za-z_$][\w$]*$/.test(exported)) out.push({ name: exported, local, offset: m.index as number });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Offset of the module's default export (`export default …` or `export { x as default }`), if any. */
export function defaultExportOffset(skeleton: string): number | undefined {
  const m = /\bexport\s+default\b/.exec(skeleton);
  if (m) return m.index;
  return exportedNames(skeleton).find((e) => e.name === "default")?.offset;
}

/** The name of a default-exported function or class (`export default async function handler`), if named. */
export function defaultExportName(skeleton: string): string | undefined {
  const m = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?|class)\s*([A-Za-z_$][\w$]*)/.exec(skeleton);
  if (m) return m[1];
  const bare = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*(?:\n|$)/.exec(skeleton);
  return bare && !["async", "function", "class"].includes(bare[1] as string) ? bare[1] : undefined;
}

/** Same-file string constants: `const BASE = "/api"` (plain literals only). */
export function stringConstants(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g)) {
    const raw = `${m[2]}${m[3]}${m[2]}`;
    const value = stringLiteral(raw);
    if (value !== undefined && !out.has(m[1] as string)) out.set(m[1] as string, value);
  }
  return out;
}

export interface Prop {
  /** The key, unquoted (`url`, `method`); "" for spreads and computed keys. */
  key: string;
  /** The value's source text (the key itself for shorthand). */
  value: string;
  /** Offset of the value in the file. */
  start: number;
  /** Offset of the property in the file. */
  at: number;
}

/** Index of the first top-level `:` of a property's source, or -1. */
function topLevelColon(raw: string): number {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = raw.indexOf(ch, i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

/** The top-level properties of the object literal whose `{` is at `open`. Undefined when it never closes. */
export function objectProps(text: string, open: number): { props: Prop[]; end: number } | undefined {
  if (text[open] !== "{") return undefined;
  const read = readArgs(text, open);
  if (!read) return undefined;
  const props: Prop[] = [];
  for (const arg of read.args) {
    const raw = arg.raw;
    if (raw.startsWith("...")) {
      props.push({ key: "", value: raw.slice(3), start: arg.start + 3, at: arg.start });
      continue;
    }
    const colon = topLevelColon(raw);
    if (colon === -1) {
      // Shorthand `handler` or method `async handler() {}`.
      const m = /^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)/.exec(raw);
      if (m) props.push({ key: m[1] as string, value: raw, start: arg.start, at: arg.start });
      continue;
    }
    const keyRaw = raw.slice(0, colon).trim();
    const key = stringLiteral(keyRaw) ?? (/^[A-Za-z_$][\w$]*$/.test(keyRaw) ? keyRaw : "");
    const after = raw.slice(colon + 1);
    const lead = after.length - after.trimStart().length;
    props.push({ key, value: after.trim(), start: arg.start + colon + 1 + lead, at: arg.start });
  }
  return { props, end: read.end };
}

/** The value of property `key`, if present. */
export function propValue(props: readonly Prop[], key: string): Prop | undefined {
  return props.find((p) => p.key === key);
}

export interface ChainCall {
  name: string;
  /** Offset of the `.` before the name. */
  dot: number;
  args: Arg[];
  end: number;
}

/** The `.name(args)` calls chained right after offset `at` (`.get(h).post(h)`), in order. */
export function chainAfter(skeleton: string, text: string, at: number): ChainCall[] {
  const out: ChainCall[] = [];
  let pos = at;
  for (;;) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>\s*)?\(/.exec(skeleton.slice(pos, pos + 400));
    if (!m) break;
    const open = pos + m[0].length - 1;
    const call = readArgs(text, open);
    if (!call) break;
    out.push({ name: m[1] as string, dot: skeleton.indexOf(".", pos), args: call.args, end: call.end });
    pos = call.end;
  }
  return out;
}

/** The plain string values of a literal or an array of literals (`"GET"`, `["GET", "POST"]`). */
export function literalList(raw: string): string[] | undefined {
  const one = stringLiteral(raw);
  if (one !== undefined) return [one];
  if (!raw.startsWith("[") || !raw.endsWith("]")) return undefined;
  const out: string[] = [];
  for (const part of raw.slice(1, -1).split(",")) {
    const p = part.trim();
    if (!p) continue;
    const v = stringLiteral(p);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}

/** End (exclusive) of the identifier starting at `i`. */
function identEnd(s: string, i: number): number {
  let j = i;
  while (j < s.length && /[\w$]/.test(s[j] as string)) j++;
  return j;
}

function skipSpace(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j] as string)) j++;
  return j;
}

export interface Decorator {
  /** The decorator's name, last dotted segment (`Get` for `@Get`, `Column` for `@orm.Column`). */
  name: string;
  /** Its call arguments; undefined for a bare `@Decorator`. */
  args?: Arg[];
  start: number;
  end: number;
}

/** Parse a run of decorators starting at `i` (an `@`). Returns them and the offset after the run. */
export function decoratorRun(skeleton: string, text: string, i: number): { decorators: Decorator[]; end: number } {
  const decorators: Decorator[] = [];
  let last = i;
  for (;;) {
    const pos = skipSpace(skeleton, last);
    if (skeleton[pos] !== "@") break;
    const m = /^@\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/.exec(skeleton.slice(pos, pos + 200));
    if (!m) break;
    const name = (m[1] as string).split(".").pop()?.trim() as string;
    let end = pos + m[0].length;
    let args: Arg[] | undefined;
    const open = skipSpace(skeleton, end);
    if (skeleton[open] === "(") {
      const call = readArgs(text, open);
      if (!call) break;
      args = call.args;
      end = call.end;
    }
    decorators.push({ name, args, start: pos, end });
    last = end;
  }
  return { decorators, end: last };
}

export interface ClassMember {
  decorators: Decorator[];
  name: string;
  kind: "property" | "method";
  /** The property's type annotation, whitespace collapsed. */
  type?: string;
  /** Offset of the member's name. */
  start: number;
}

export interface ClassDecl {
  name: string;
  /** What follows the name up to the body: `extends Model<…> implements X`. */
  heritage: string;
  decorators: Decorator[];
  /** Offset of the `class` keyword. */
  start: number;
  /** Offset of the body's `{` and just after its `}`. */
  bodyOpen: number;
  bodyEnd: number;
  /** Decorated members only (fields and handlers are what extractors want). */
  members: ClassMember[];
}

const MODIFIERS = new Set(["public", "private", "protected", "readonly", "static", "async", "declare", "override", "abstract", "accessor", "get", "set"]);

/** End of the brace block opening at `open` (exclusive), on the skeleton (strings blanked). */
function blockEnd(skeleton: string, open: number): number {
  let depth = 0;
  for (let i = open; i < skeleton.length; i++) {
    const ch = skeleton[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return skeleton.length;
}

function decoratedMembers(skeleton: string, text: string, from: number, to: number): ClassMember[] {
  const out: ClassMember[] = [];
  let depth = 0;
  let i = from;
  while (i < to) {
    const ch = skeleton[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "@" && depth === 0) {
      const run = decoratorRun(skeleton, text, i);
      if (!run.decorators.length) {
        i++;
        continue;
      }
      let pos = skipSpace(skeleton, run.end);
      for (;;) {
        const word = skeleton.slice(pos, identEnd(skeleton, pos));
        const after = skipSpace(skeleton, pos + word.length);
        if (MODIFIERS.has(word) && /[A-Za-z_$*[#]/.test(skeleton[after] ?? "")) pos = after;
        else break;
      }
      if (skeleton[pos] === "*") pos = skipSpace(skeleton, pos + 1);
      const nameEnd = identEnd(skeleton, pos);
      const name = skeleton.slice(pos, nameEnd);
      if (!name) {
        i = run.end;
        continue;
      }
      let k = skipSpace(skeleton, nameEnd);
      if (skeleton[k] === "?" || skeleton[k] === "!") k = skipSpace(skeleton, k + 1);
      const member: ClassMember = { decorators: run.decorators, name, kind: "property", start: pos };
      if (skeleton[k] === "(" || skeleton[k] === "<") member.kind = "method";
      else if (skeleton[k] === ":") {
        let d = 0;
        let j = k + 1;
        for (; j < to; j++) {
          const c = skeleton[j];
          if (c === "{" || c === "(" || c === "[" || c === "<") d++;
          else if (c === "}" || c === ")" || c === "]" || c === ">") {
            if (d === 0) break;
            d--;
          } else if (d === 0 && (c === ";" || c === "=" || c === "\n")) break;
        }
        member.type = text
          .slice(k + 1, j)
          .replace(/\s+/g, " ")
          .trim();
      }
      out.push(member);
      i = nameEnd;
      continue;
    }
    i++;
  }
  return out;
}

const CLASS_PREFIXES = new Set(["export", "default", "abstract", "declare"]);

/** Offset just after the last non-space character before `i` (0 when none). */
function endBeforeSpace(s: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1] as string)) j--;
  return j;
}

/** Every class declaration of a file, with its decorators and decorated members. */
export function classDeclarations(skeleton: string, text: string): ClassDecl[] {
  // Decorator runs, keyed by their end offset (whitespace trimmed).
  const runs = new Map<number, Decorator[]>();
  for (const m of skeleton.matchAll(/(?<![\w$.@])@\s*[A-Za-z_$]/g)) {
    const at = m.index as number;
    // Inside a run already parsed: right after another decorator's `)` or name.
    const prev = endBeforeSpace(skeleton, at);
    if (skeleton[prev - 1] === ")") continue;
    let w = prev;
    while (w > 0 && /[\w$.]/.test(skeleton[w - 1] as string)) w--;
    if (w < prev && skeleton[w - 1] === "@") continue;
    const run = decoratorRun(skeleton, text, at);
    if (run.decorators.length) runs.set(run.end, run.decorators);
  }
  const out: ClassDecl[] = [];
  for (const m of skeleton.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)([^{;]*)\{/g)) {
    const start = m.index as number;
    // Step back over `export default abstract declare` to where a decorator run would end.
    let end = endBeforeSpace(skeleton, start);
    for (;;) {
      let w = end;
      while (w > 0 && /\w/.test(skeleton[w - 1] as string)) w--;
      if (!CLASS_PREFIXES.has(skeleton.slice(w, end))) break;
      end = endBeforeSpace(skeleton, w);
    }
    const decorators = runs.get(end) ?? [];
    const bodyOpen = start + m[0].length - 1;
    const bodyEnd = blockEnd(skeleton, bodyOpen);
    out.push({
      name: m[1] as string,
      heritage: (m[2] as string).replace(/\s+/g, " ").trim(),
      decorators,
      start,
      bodyOpen,
      bodyEnd,
      members: decoratedMembers(skeleton, text, bodyOpen + 1, bodyEnd - 1),
    });
  }
  return out;
}

/** The class `() => User` / `type => User` / `"User"` names (decorator relation targets). */
export function classTarget(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const arrow = /^(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\[\s*)?([A-Za-z_$][\w$]*)/.exec(raw);
  if (arrow) return arrow[1];
  const lit = stringLiteral(raw);
  if (lit && /^[A-Za-z_$][\w$]*$/.test(lit)) return lit;
  return /^[A-Z][\w$]*$/.test(raw) ? raw : undefined;
}
