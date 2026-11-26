// Outbound HTTP calls from Python: requests and httpx.
//
//   requests.get(url) … requests.request("GET", url)
//   s = requests.Session(); s.post(url)            (also `with … as s`)
//   httpx.get(url); c = httpx.Client(base_url=…); c.get("/x")
//   async with httpx.AsyncClient(base_url=…) as c: await c.get("/x")
//
// URLs are normalized like every call fact (docs/design.md §5): f-string and
// concatenated substitutions become `:p`, a leading non-literal base
// (`f"{settings.API_URL}/orders"`, an env/config-based `base_url`) is dropped,
// the query and fragment are dropped. A URL with no literal part is skipped.
// Only `CallFact`s are emitted; matching calls to routes is a linker's job.

import { type Arg, readArgs } from "./js.js";
import { lineIndex, maskSource } from "./mask.js";
import { importsPyModule, isPython, kwarg, positional, pyImports, pyString } from "./py.js";
import type { CallFact, ExtractInput, ExtractOutput, Extractor, RepoContext } from "./types.js";

const VERBS = ["get", "post", "put", "patch", "delete", "head", "options"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Placeholder for a non-literal part of a URL while it is assembled. */
const HOLE = "\uE000"; // a private-use character: never in a URL

/** Split `raw` on top-level `+` (string concatenation). */
function concatParts(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "+" && depth === 0) {
      parts.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(raw.slice(start).trim());
  return parts;
}

/** An f-string body with every `{…}` substitution replaced by HOLE (`{{` / `}}` are literal braces). */
function fillHoles(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" && body[i + 1] === "{") {
      out += "{";
      i++;
    } else if (ch === "}" && body[i + 1] === "}") {
      out += "}";
      i++;
    } else if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < body.length && depth) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
        j++;
      }
      out += HOLE;
      i = j - 1;
    } else out += ch;
  }
  return out;
}

/** A URL expression as text with HOLEs, or undefined when no part of it is a literal. */
function urlTemplate(raw: string): string | undefined {
  let out = "";
  let literal = false;
  for (const part of concatParts(raw)) {
    const s = pyString(part);
    if (!s) {
      out += HOLE;
      continue;
    }
    literal = true;
    out += s.f ? fillHoles(s.value) : s.value;
  }
  return literal ? out : undefined;
}

/**
 * Normalize a URL template: drop a leading base HOLE, the query and the
 * fragment; HOLEs left in the path become `:p`. `base` is the client's base
 * URL: a literal is prefixed, "" (a non-literal base, dropped) makes a
 * relative path absolute. Undefined when what remains is neither an absolute
 * URL nor a path.
 */
export function normalizePyUrl(template: string, base?: string): string | undefined {
  let url = template.replace(/[?#][\s\S]*$/, "");
  if (url.startsWith(HOLE)) url = url.replace(/^\uE000+/, "");
  if (!/^https?:\/\//i.test(url)) {
    const path = url && !url.startsWith("/") && base !== undefined ? `/${url}` : url;
    if (base) url = `${base.replace(/\/+$/, "")}${path}`;
    else if (path.startsWith("/")) url = path;
    else return undefined;
  }
  url = url.replace(/\uE000+/g, ":p");
  return url || undefined;
}

interface Receiver {
  /** A literal base URL, or "" when the base is not a literal (dropped). */
  base?: string;
}

/** `base_url=` of an httpx client: the literal, "" when given but not literal, undefined when absent. */
function baseOf(args: readonly Arg[]): string | undefined {
  const b = kwarg(args, "base_url");
  if (!b) return undefined;
  const s = pyString(b.raw);
  if (!s || s.f) return "";
  return s.value.replace(/[?#][\s\S]*$/, "");
}

function extractPyHttp(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const deps = ctx.depsFor(input.rel);
  const text = maskSource(input.rel, input.text);
  const skeleton = maskSource(input.rel, input.text, { strings: true });
  const lineOf = lineIndex(text);
  const imports = pyImports(text);
  // Module aliases: `import requests`, `import httpx as hx`.
  const modules = new Map<string, "requests" | "httpx">();
  for (const lib of ["requests", "httpx"] as const) {
    if (!deps.has(lib) || !importsPyModule(text, lib)) continue;
    for (const [local, imp] of imports) if (imp.name === undefined && imp.module === lib) modules.set(local, lib);
  }
  if (!modules.size) return {};
  const receivers = new Map<string, Receiver>();
  for (const [local] of modules) receivers.set(local, {});
  const mods = [...modules.keys()].map(esc).join("|");
  // Instances: `s = requests.Session()`, `c = httpx.Client(base_url=…)`, `with … as c`.
  const CTOR = `(${mods})\\s*\\.\\s*(Session|session|Client|AsyncClient)\\s*\\(`;
  const ASSIGN = new RegExp(`^[ \\t]*((?:self\\.)?[A-Za-z_]\\w*)[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:await\\s+)?${CTOR}`, "gm");
  const WITH = new RegExp(`\\bwith\\s+${CTOR}`, "g");
  for (const m of skeleton.matchAll(ASSIGN)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    receivers.set(m[1] as string, { base: call ? baseOf(call.args) : undefined });
  }
  for (const m of skeleton.matchAll(WITH)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    const as = /^\s*as\s+([A-Za-z_]\w*)/.exec(skeleton.slice(call.end, call.end + 100));
    if (as) receivers.set(as[1] as string, { base: baseOf(call.args) });
  }
  const names = [...receivers.keys()].map(esc).join("|");
  const CALL = new RegExp(`(?<![\\w.])(${names})\\s*\\.\\s*(${VERBS.join("|")}|request|stream)\\s*\\(`, "g");
  const calls: CallFact[] = [];
  for (const m of skeleton.matchAll(CALL)) {
    const recv = receivers.get(m[1] as string) as Receiver;
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    const pos = positional(call.args);
    let method: string | undefined;
    let urlArg: Arg | undefined;
    const fn = m[2] as string;
    if (fn === "request" || fn === "stream") {
      const verb = pos[0] ?? kwarg(call.args, "method");
      const lit = verb ? pyString(verb.raw) : undefined;
      if (!lit || lit.f) continue;
      method = lit.value.toUpperCase();
      urlArg = pos[1] ?? kwarg(call.args, "url");
    } else {
      method = fn.toUpperCase();
      urlArg = pos[0] ?? kwarg(call.args, "url");
    }
    if (!urlArg || !/^[A-Z]+$/.test(method)) continue;
    const template = urlTemplate(urlArg.raw);
    if (template === undefined) continue;
    const url = normalizePyUrl(template, recv.base);
    if (!url) continue;
    calls.push({ method, url, file: input.rel, line: lineOf(m.index as number) });
  }
  return calls.length ? { calls } : {};
}

export const pythonHttpExtractor: Extractor = {
  id: "python-http",
  applies(input: ExtractInput, ctx: RepoContext): boolean {
    if (!isPython(input.rel)) return false;
    const deps = ctx.depsFor(input.rel);
    return deps.has("requests") || deps.has("httpx");
  },
  extract: extractPyHttp,
};
