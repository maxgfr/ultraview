// Outbound HTTP calls from JS/TS (and Vue / Svelte <script>), and the linker
// that matches them to the routes the repo serves.
//
// Call sites:
//   fetch(url, { method })                  global fetch (window./globalThis./self.)
//   axios.get/post/…(url), axios(url | { url, method }), axios.request({ … })
//   ky.get/post/…(url), ky(url, { method })
//   ofetch(url, { method }), $fetch(url, { method })   (ofetch dep, or Nuxt / Nitro)
//   useFetch / useLazyFetch(url, { method })           (Nuxt)
//   instances: const api = axios.create({ baseURL }) / ky.create({ prefixUrl })
//              / ofetch.create({ baseURL }) — same-file calls get the base
//              here; exported instances become `http-client` hints and calls
//              through an imported one `client-call` hints, settled by the
//              `http-calls` linker.
//
// URL normalisation is shared with the Python call extractor (urls.ts): this
// file only parses JS URL expressions into a template — template
// substitutions and concatenated expressions are holes, a same-file string
// constant is substituted — and urls.ts applies the rules (leading base
// dropped, localhost and expression-built hosts dropped, query and hash
// dropped, holed segments → `:p`). Absolute URLs to other hosts stay absolute:
// calls to someone else's API, never matched to our routes.

import { type Arg, readArgs, stringLiteral } from "./js.js";
import { routeMatchKey } from "./routing.js";
import {
  declares,
  exportedNames,
  importBindings,
  isLocalSpecifier,
  isScriptFile,
  namesImportedFrom,
  objectProps,
  propValue,
  resolveLocalModule,
  sourceViews,
  stringConstants,
} from "./source.js";
import type {
  CallFact,
  ClientCallHint,
  ExtractInput,
  ExtractOutput,
  Extractor,
  Facts,
  HttpClientHint,
  LinkContext,
  Linker,
  RepoContext,
  RouteFact,
} from "./types.js";
import { isAbsoluteUrl, joinBaseUrl, normalizeBaseUrl, normalizeUrlTemplate, URL_HOLE } from "./urls.js";

type Part = { lit: string } | { expr: string };

const VERBS = ["get", "post", "put", "patch", "delete", "head", "options"];

/** Split an expression on top-level `+`. */
function splitConcat(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let braces = 0;
      for (; j < raw.length; j++) {
        const c = raw[j];
        if (c === "\\") {
          j++;
          continue;
        }
        if (quote === "`" && c === "$" && raw[j + 1] === "{") {
          braces++;
          j++;
          continue;
        }
        if (braces > 0) {
          if (c === "{") braces++;
          else if (c === "}") braces--;
          continue;
        }
        if (c === quote) break;
      }
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "+" && depth === 0) {
      out.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(raw.slice(start).trim());
  return out;
}

/** The literal and substitution parts of a template literal's source. */
function templateParts(raw: string): Part[] {
  const body = raw.slice(1, -1);
  const out: Part[] = [];
  let lit = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      lit += body[i + 1] ?? "";
      i++;
      continue;
    }
    if (ch === "$" && body[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < body.length && depth > 0; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
      }
      if (lit) out.push({ lit });
      lit = "";
      out.push({ expr: body.slice(i + 2, j - 1).trim() });
      i = j - 1;
      continue;
    }
    lit += ch;
  }
  if (lit) out.push({ lit });
  return out;
}

/** The parts of a URL expression: literals, templates, concatenations, same-file constants. Undefined when nothing is literal. */
export function urlParts(raw: string, consts: ReadonlyMap<string, string> = new Map()): Part[] | undefined {
  let src = raw.trim().replace(/\s+as\s+[\w$.<>[\]]+$/, "");
  const arrow = /^(?:async\s+)?(?:\(\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(src);
  if (arrow) src = src.slice(arrow[0].length).trim();
  const parts: Part[] = [];
  for (const piece of splitConcat(src)) {
    const lit = stringLiteral(piece);
    if (lit !== undefined) parts.push({ lit });
    else if (piece.startsWith("`") && piece.endsWith("`") && piece.length >= 2) {
      for (const p of templateParts(piece)) {
        if ("expr" in p && consts.has(p.expr)) parts.push({ lit: consts.get(p.expr) as string });
        else parts.push(p);
      }
    } else if (consts.has(piece)) parts.push({ lit: consts.get(piece) as string });
    else parts.push({ expr: piece });
  }
  // Merge adjacent literals.
  const merged: Part[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if ("lit" in p && prev && "lit" in prev) prev.lit += p.lit;
    else merged.push({ ...p });
  }
  return merged.some((p) => "lit" in p) ? merged : undefined;
}

/** Normalize URL parts (see urls.ts): each non-literal part is a hole in the shared template. */
export function normalizeUrlParts(parts: readonly Part[]): string | undefined {
  return normalizeUrlTemplate(parts.map((p) => ("lit" in p ? p.lit : URL_HOLE)).join(""));
}

/** Normalize a URL expression's source. */
export function normalizeUrl(raw: string, consts?: ReadonlyMap<string, string>): string | undefined {
  const parts = urlParts(raw, consts);
  return parts ? normalizeUrlParts(parts) : undefined;
}

/** A client's base URL from its config value: undefined when absent, "" when not a literal, else normalized. */
function normalizeBase(raw: string | undefined, consts: ReadonlyMap<string, string>): string | undefined {
  if (raw === undefined) return undefined;
  const parts = urlParts(raw, consts);
  return parts ? normalizeBaseUrl(parts.map((p) => ("lit" in p ? p.lit : URL_HOLE)).join("")) : "";
}

function methodOf(props: ReturnType<typeof objectProps>, fallback: string): string {
  const raw = props ? propValue(props.props, "method")?.value : undefined;
  const lit = raw ? stringLiteral(raw) : undefined;
  return lit ? lit.toUpperCase() : fallback;
}

function optsOf(text: string, arg: Arg | undefined): ReturnType<typeof objectProps> {
  return arg?.raw.startsWith("{") ? objectProps(text, arg.start) : undefined;
}

type Lib = "axios" | "ky" | "ofetch";

const BASE_KEYS: Record<Lib, string[]> = { axios: ["baseURL"], ky: ["prefixUrl", "prefix"], ofetch: ["baseURL"] };

function escapeNames(names: Iterable<string>): string {
  return [...names].map((n) => n.replace(/\$/g, "\\$")).join("|");
}

function extractCalls(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  const consts = stringConstants(text);
  const bindings = importBindings(text);
  const deps = ctx.depsFor(input.rel);
  const nuxt = declares(ctx, input.rel, ["nuxt", "nuxt3", "nitropack", "nitro"]);
  const calls: CallFact[] = [];
  const hints: (HttpClientHint | ClientCallHint)[] = [];
  const emit = (method: string, url: string | undefined, offset: number) => {
    if (url === undefined || !(url.startsWith("/") || isAbsoluteUrl(url))) return;
    calls.push({ method, url, file: input.rel, line: lineOf(offset) });
  };

  // Library entry points the workspace declares.
  const libs = new Map<string, Lib>();
  if (deps.has("axios")) for (const n of ["axios", ...namesImportedFrom(bindings, "axios")]) libs.set(n, "axios");
  if (deps.has("ky")) for (const n of ["ky", ...namesImportedFrom(bindings, "ky")]) libs.set(n, "ky");
  if (deps.has("ofetch") || nuxt) {
    for (const n of namesImportedFrom(bindings, "ofetch", "ofetch")) libs.set(n, "ofetch");
    for (const n of namesImportedFrom(bindings, "ofetch", "$fetch")) libs.set(n, "ofetch");
    if (deps.has("ofetch")) libs.set("ofetch", "ofetch");
    libs.set("$fetch", "ofetch");
  }

  // Instances: `const api = axios.create({ baseURL })`, `export default ky.create({ prefixUrl })`.
  const instances = new Map<string, string | undefined>();
  if (libs.size) {
    const CREATE = new RegExp(
      `(?:\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=|\\bexport\\s+default)\\s*(${escapeNames(libs.keys())})\\s*\\.\\s*(create|extend)\\s*\\(`,
      "g",
    );
    for (const m of skeleton.matchAll(CREATE)) {
      const lib = libs.get(m[2] as string) as Lib;
      const call = readArgs(text, (m.index as number) + m[0].length - 1);
      if (!call) continue;
      const opts = optsOf(text, call.args[0]);
      const baseRaw = opts ? BASE_KEYS[lib].map((k) => propValue(opts.props, k)?.value).find((v) => v !== undefined) : undefined;
      const base = normalizeBase(baseRaw, consts);
      if (m[1]) instances.set(m[1], base);
      else hints.push({ kind: "http-client", file: input.rel, name: "default", base });
    }
    for (const e of exportedNames(skeleton)) {
      if (instances.has(e.local)) hints.push({ kind: "http-client", file: input.rel, name: e.name, base: instances.get(e.local) });
    }
    const def = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*(?:\n|$)/.exec(skeleton);
    if (def && instances.has(def[1] as string)) hints.push({ kind: "http-client", file: input.rel, name: "default", base: instances.get(def[1] as string) });
  }

  // fetch(url, init)
  for (const m of skeleton.matchAll(/(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?fetch\s*\(/g)) {
    const at = m.index as number;
    if (/\b(?:function|async)\s*$/.test(skeleton.slice(Math.max(0, at - 20), at))) continue;
    const call = readArgs(text, at + m[0].length - 1);
    if (!call?.args[0]) continue;
    emit(methodOf(optsOf(text, call.args[1]), "GET"), normalizeUrl(call.args[0].raw, consts), at);
  }

  // Nuxt composables.
  if (nuxt) {
    for (const m of skeleton.matchAll(/(?<![\w$.])(?:useFetch|useLazyFetch)\s*(?:<[^()]*>)?\s*\(/g)) {
      const call = readArgs(text, (m.index as number) + m[0].length - 1);
      if (!call?.args[0]) continue;
      emit(methodOf(optsOf(text, call.args[1]), "GET"), normalizeUrl(call.args[0].raw, consts), m.index as number);
    }
  }

  /** Calls on `names`: `.verb(url)`, `(url, opts)`, `({ url, method })`, `.request({ … })`, `.raw(url, opts)`. */
  const scanReceivers = (names: string[], onCall: (name: string, method: string, url: string | undefined, offset: number) => void) => {
    if (!names.length) return;
    const alt = escapeNames(names);
    const VERB = new RegExp(`(?<![\\w$.])(${alt})\\s*\\.\\s*(${VERBS.join("|")}|request|raw)\\s*(?:<[^()]*>)?\\s*\\(`, "g");
    for (const m of skeleton.matchAll(VERB)) {
      const call = readArgs(text, (m.index as number) + m[0].length - 1);
      const first = call?.args[0];
      if (!call || !first) continue;
      const verb = m[2] as string;
      if (verb === "request" || (verb === "raw" && first.raw.startsWith("{"))) {
        const cfg = optsOf(text, first);
        const url = cfg ? propValue(cfg.props, "url")?.value : undefined;
        if (url) onCall(m[1] as string, methodOf(cfg, "GET"), normalizeUrl(url, consts), m.index as number);
        continue;
      }
      // axios.post(url, data, config): the method is the verb.
      const method = verb === "raw" ? methodOf(optsOf(text, call.args[1]), "GET") : verb.toUpperCase();
      onCall(m[1] as string, method, normalizeUrl(first.raw, consts), m.index as number);
    }
    const CALL = new RegExp(`(?<![\\w$.])(${alt})\\s*(?:<[^()]*>)?\\s*\\(`, "g");
    for (const m of skeleton.matchAll(CALL)) {
      const at = m.index as number;
      if (/\b(?:function|async|new)\s*$/.test(skeleton.slice(Math.max(0, at - 20), at))) continue;
      const call = readArgs(text, at + m[0].length - 1);
      const first = call?.args[0];
      if (!call || !first) continue;
      if (first.raw.startsWith("{")) {
        const cfg = optsOf(text, first);
        const url = cfg ? propValue(cfg.props, "url")?.value : undefined;
        if (url) onCall(m[1] as string, methodOf(cfg, "GET"), normalizeUrl(url, consts), at);
        continue;
      }
      onCall(m[1] as string, methodOf(optsOf(text, call.args[1]), "GET"), normalizeUrl(first.raw, consts), at);
    }
  };

  // Library entry points: no base. Same-file instances: their base.
  scanReceivers([...libs.keys()].sort(), (_name, method, url, offset) => emit(method, url, offset));
  scanReceivers([...instances.keys()].sort(), (name, method, url, offset) => {
    if (url !== undefined) emit(method, joinBaseUrl(instances.get(name), url), offset);
  });

  // Imported objects that may be clients: settled by the linker against `http-client` hints.
  const imported = new Map<string, { module: string; name: string }>();
  for (const [local, b] of bindings) {
    if (libs.has(local) || instances.has(local) || b.imported === "*" || !isLocalSpecifier(b.spec)) continue;
    const module = resolveLocalModule(ctx, input.rel, b.spec);
    if (module) imported.set(local, { module, name: b.imported });
  }
  scanReceivers([...imported.keys()].sort(), (name, method, url, offset) => {
    const target = imported.get(name);
    if (!target || url === undefined) return;
    hints.push({ kind: "client-call", file: input.rel, line: lineOf(offset), method, url, module: target.module, name: target.name });
  });

  const out: ExtractOutput = {};
  if (calls.length) out.calls = calls;
  if (hints.length) out.hints = hints;
  return out;
}

export const httpCallsExtractor: Extractor = {
  id: "http-calls",
  applies(input) {
    return isScriptFile(input.rel);
  },
  extract: extractCalls,
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The route a call reaches: same method (or a route serving ALL), path pattern match, most specific first. */
export function matchCallRoute(call: Pick<CallFact, "method" | "url">, routes: readonly RouteFact[]): RouteFact | undefined {
  if (!call.url.startsWith("/")) return undefined;
  let best: { r: RouteFact; key: [number, number, number, string] } | undefined;
  for (const r of routes) {
    const exact = r.method === call.method;
    if (!exact && r.method !== "ALL") continue;
    const m = routeMatchKey(call.url, r.path);
    if (!m) continue;
    const key: [number, number, number, string] = [m[0], m[1], exact ? 0 : 1, `${r.method} ${r.path} ${r.file}`];
    if (lessKey(key, best?.key)) best = { r, key };
  }
  return best?.r;
}

function lessKey(a: [number, number, number, string], b: [number, number, number, string] | undefined): boolean {
  if (!b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  return cmp(a[3], b[3]) < 0;
}

/**
 * Settle calls: calls through imported clients become call facts (base
 * joined) when the module exports a client by that name; then each call with
 * a path is matched to a route by method + path pattern (`route:<METHOD> <path>`).
 * Unmatched calls keep no route.
 */
export const httpCallLinker: Linker = {
  id: "http-calls",
  link(facts: Facts, ctx: LinkContext): Facts {
    const clients = new Map<string, string | undefined>();
    for (const h of ctx.hints) if (h.kind === "http-client") clients.set(`${h.file}\u0000${h.name}`, h.base);
    const calls = [...facts.calls];
    for (const h of ctx.hints) {
      if (h.kind !== "client-call") continue;
      const key = `${h.module}\u0000${h.name}`;
      if (!clients.has(key)) continue;
      const url = joinBaseUrl(clients.get(key), h.url);
      if (url !== undefined) calls.push({ method: h.method, url, file: h.file, line: h.line });
    }
    if (!facts.routes.length && calls.length === facts.calls.length) return facts;
    return {
      ...facts,
      calls: calls.map((c) => {
        if (c.route !== undefined) return c;
        const r = matchCallRoute(c, facts.routes);
        return r ? { ...c, route: `route:${r.method} ${r.path}` } : c;
      }),
    };
  },
};
