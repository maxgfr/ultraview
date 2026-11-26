// Hono and Fastify routes: verb calls on receivers that are provably the
// framework's app, same-file prefixes applied here, cross-file prefixes left
// as mount hints for the `js-mounts` linker (shared mounts.ts machinery).
//
// Hono      `new Hono()` (or `OpenAPIHono`) receivers and parameters typed
//           `Hono`; `app.get/post/put/patch/delete/all/options(path, …)`,
//           `app.on(method | [methods], path, …)`, chained calls,
//           `basePath(prefix)`, `app.route(prefix, sub)` mounts.
// Fastify   `Fastify()` / `require("fastify")()` receivers, parameters typed
//           `FastifyInstance`, and the plugin convention `fastify`;
//           `fastify.get/…(path, …)`, `fastify.route({ method, url })`,
//           `fastify.register(plugin, { prefix })` — inline and same-file
//           plugins get the prefix here, imported ones through the linker.

import { type Arg, identifierPath, importsModule, moduleFile, readArgs, stringLiteral } from "./js.js";
import { applyMounts, joinRoutePath } from "./mounts.js";
import { cleanRoutePath, stripParamPatterns } from "./routing.js";
import {
  chainAfter,
  declares,
  importBindings,
  isScriptFile,
  isLocalSpecifier,
  literalList,
  moduleTarget,
  namesImportedFrom,
  objectProps,
  propValue,
  resolveLocalModule,
  sourceViews,
} from "./source.js";
import type { ExtractInput, ExtractOutput, Extractor, Linker, MountHint, RepoContext, RouteFact } from "./types.js";

interface RawRoute {
  receiver: string;
  method: string;
  path: string;
  offset: number;
  handler?: string;
  /** Prefix contributed by the call's own chain (`app.basePath("/v1").get(…)`). */
  chainPrefix?: string;
}

interface RawMount {
  parent: string;
  prefix: string;
  local?: string;
  target?: string;
  offset: number;
}

/** A virtual parent: a receiver mounted under it has a base path of its own (`new Hono().basePath("/api")`). */
const ROOT = "\u0000root";

function lastHandler(args: readonly Arg[]): string | undefined {
  const last = args[args.length - 1];
  return last ? identifierPath(last.raw) : undefined;
}

function isRoutePath(path: string): boolean {
  return path.startsWith("/") || path === "*" || path === "";
}

/** Compose same-file mount prefixes of a receiver (cycles cut). */
function prefixesOf(mounts: readonly RawMount[], recv: string, seen: Set<string> = new Set()): string[] {
  if (recv === ROOT) return [""];
  const parents = mounts.filter((m) => m.local === recv);
  if (!parents.length || seen.has(recv)) return [""];
  const next = new Set(seen).add(recv);
  return [...new Set(parents.flatMap((p) => prefixesOf(mounts, p.parent, next).map((outer) => joinRoutePath(outer, p.prefix))))];
}

/** The mounted module of `raw` (`sub`, `require("./x")`, `import("./x")`), resolved to a hint target. */
function mountedModule(ctx: RepoContext, rel: string, raw: string, imports: ReturnType<typeof importBindings>): string | undefined {
  const dyn = /^(?:await\s+)?(?:require|import)\s*\(\s*(["'])([^"']+)\1\s*\)(?:\s*\.\s*[\w$]+)?$/.exec(raw);
  const spec = dyn ? dyn[2] : /^[A-Za-z_$][\w$]*$/.test(raw) ? imports.get(raw)?.spec : undefined;
  if (!spec || !isLocalSpecifier(spec)) return undefined;
  const file = resolveLocalModule(ctx, rel, spec);
  return file ? moduleTarget(file) : undefined;
}

function toFacts(input: ExtractInput, framework: string, routes: RawRoute[], prefixes: (r: RawRoute) => string[], lineOf: (o: number) => number): RouteFact[] {
  const out: RouteFact[] = [];
  for (const r of routes) {
    for (const prefix of prefixes(r)) {
      const path = cleanRoutePath(stripParamPatterns(joinRoutePath(joinRoutePath(prefix, r.chainPrefix ?? ""), r.path)));
      const fact: RouteFact = { method: r.method, path, file: input.rel, line: lineOf(r.offset), framework };
      if (r.handler) fact.handler = r.handler;
      out.push(fact);
    }
  }
  return out;
}

// --- Hono -------------------------------------------------------------------

const HONO_VERBS = new Set(["get", "post", "put", "patch", "delete", "all", "options"]);

function extractHono(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  const imports = importBindings(text);
  const receivers = new Set<string>();
  const routes: RawRoute[] = [];
  const mounts: RawMount[] = [];

  // One call on `recv`: a route, a mount, or a base path for the rest of its chain.
  const onCall = (recv: string, name: string, args: Arg[], offset: number, chain: { prefix: string; assigned: boolean }): boolean => {
    const first = args[0] ? stringLiteral(args[0].raw) : undefined;
    // Middleware and hooks keep a chain going without declaring a route.
    if (name === "use" || name === "notFound" || name === "onError") return true;
    if (HONO_VERBS.has(name)) {
      if (first === undefined || !isRoutePath(first) || args.length < 2) return false;
      routes.push({ receiver: recv, method: name.toUpperCase(), path: first, offset, handler: lastHandler(args.slice(1)), chainPrefix: chain.prefix });
      return true;
    }
    if (name === "on") {
      const methods = args[0] ? literalList(args[0].raw) : undefined;
      const path = args[1] ? stringLiteral(args[1].raw) : undefined;
      if (!methods || path === undefined || !isRoutePath(path) || args.length < 3) return false;
      for (const m of methods)
        routes.push({ receiver: recv, method: m.toUpperCase(), path, offset, handler: lastHandler(args.slice(2)), chainPrefix: chain.prefix });
      return true;
    }
    if (name === "basePath") {
      if (first === undefined) return false;
      if (chain.assigned) mounts.push({ parent: ROOT, prefix: joinRoutePath(chain.prefix, first), local: recv, offset });
      else chain.prefix = joinRoutePath(chain.prefix, first);
      return true;
    }
    if (name === "route") {
      const child = args[1]?.raw;
      if (first === undefined || !first.startsWith("/") || !child) return false;
      const prefix = joinRoutePath(chain.prefix, first);
      if (receivers.has(child) && child !== recv) mounts.push({ parent: recv, prefix, local: child, offset });
      else {
        const target = mountedModule(ctx, input.rel, child, imports);
        if (target) mounts.push({ parent: recv, prefix, target, offset });
      }
      return true;
    }
    return false;
  };
  const walkChain = (recv: string, from: number, chain: { prefix: string; assigned: boolean }) => {
    for (const c of chainAfter(skeleton, text, from)) if (!onCall(recv, c.name, c.args, c.dot, chain)) break;
  };

  const ASSIGN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*new\s+(?:Hono|OpenAPIHono)\s*(?:<[^()]*>)?\s*\(/g;
  const created: { recv: string; end: number }[] = [];
  for (const m of skeleton.matchAll(ASSIGN)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    receivers.add(m[1] as string);
    created.push({ recv: m[1] as string, end: call.end });
  }
  for (const m of skeleton.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*Hono\b(?!\s*\()/g)) receivers.add(m[1] as string);
  if (!receivers.size && importsModule(text, "hono")) receivers.add("app");
  // Derived instances: `const api = app.basePath("/api")`.
  const DERIVE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*basePath\s*\(/g;
  const derived: { recv: string; at: number }[] = [];
  for (const m of skeleton.matchAll(DERIVE)) {
    if (!receivers.has(m[2] as string)) continue;
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    const prefix = call?.args[0] ? stringLiteral(call.args[0].raw) : undefined;
    if (!call || prefix === undefined) continue;
    receivers.add(m[1] as string);
    mounts.push({ parent: m[2] as string, prefix, local: m[1] as string, offset: m.index as number });
    derived.push({ recv: m[1] as string, at: call.end });
  }
  if (!receivers.size) return {};
  for (const c of created) walkChain(c.recv, c.end, { prefix: "", assigned: true });
  for (const d of derived) walkChain(d.recv, d.at, { prefix: "", assigned: true });

  const names = [...receivers].map((r) => r.replace(/\$/g, "\\$")).join("|");
  const CALL = new RegExp(`(?<![\\w$.])(${names})\\s*\\.\\s*(get|post|put|patch|delete|all|options|on|route|basePath)\\s*\\(`, "g");
  for (const m of skeleton.matchAll(CALL)) {
    const recv = m[1] as string;
    const name = m[2] as string;
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    // `const api = app.basePath(…)` was taken as a derived instance above.
    if (name === "basePath" && /=\s*$/.test(skeleton.slice(Math.max(0, (m.index as number) - 40), m.index as number))) continue;
    const chain = { prefix: "", assigned: false };
    if (onCall(recv, name, call.args, m.index as number, chain)) walkChain(recv, call.end, chain);
  }

  const facts = toFacts(input, "hono", routes, (r) => prefixesOf(mounts, r.receiver), lineOf);
  const hints: MountHint[] = [];
  for (const mt of mounts) {
    if (!mt.target) continue;
    for (const outer of prefixesOf(mounts, mt.parent)) {
      hints.push({ kind: "mount", framework: "hono", file: input.rel, line: lineOf(mt.offset), prefix: joinRoutePath(outer, mt.prefix), target: mt.target });
    }
  }
  const out: ExtractOutput = {};
  if (facts.length) out.routes = facts;
  if (hints.length) out.hints = hints;
  return out;
}

export const honoExtractor: Extractor = {
  id: "hono",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["hono", "@hono/zod-openapi"]);
  },
  extract: extractHono,
};

// --- Fastify ----------------------------------------------------------------

const FASTIFY_VERBS = new Set(["get", "head", "post", "put", "delete", "options", "patch", "all"]);

/** A function that registers routes on `param` between `start` and `end`, registered from `callRecv` under `prefix`. */
interface PluginSpan {
  start: number;
  end: number;
  param: string;
  prefix: string;
  callRecv: string;
  callOffset: number;
}

function blockEndFrom(skeleton: string, from: number): number {
  const open = skeleton.indexOf("{", from);
  if (open === -1) return from;
  let depth = 0;
  for (let i = open; i < skeleton.length; i++) {
    if (skeleton[i] === "{") depth++;
    else if (skeleton[i] === "}" && --depth === 0) return i + 1;
  }
  return skeleton.length;
}

/** The first parameter of a function expression's source (`async (app, opts) => …`, `function (f) {…}`, `app => …`). */
function firstParam(raw: string): string | undefined {
  const m = /^(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(\s*([A-Za-z_$][\w$]*)/.exec(raw) ?? /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(raw);
  return m?.[1];
}

function extractFastify(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  const imports = importBindings(text);
  const factories = new Set(["Fastify", "fastify", ...namesImportedFrom(imports, "fastify")]);
  const wrappers = new Set(["fp", ...namesImportedFrom(imports, "fastify-plugin")]);
  const receivers = new Set<string>(["fastify"]);
  const factoryAlt = [...factories].map((f) => f.replace(/\$/g, "\\$")).join("|");
  const ASSIGN = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*(?:await\\s+)?(?:(?:${factoryAlt})|require\\s*\\(\\s*["']fastify["']\\s*\\))\\s*\\(`,
    "g",
  );
  for (const m of skeleton.matchAll(ASSIGN)) receivers.add(m[1] as string);
  for (const m of skeleton.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*FastifyInstance\b/g)) receivers.add(m[1] as string);
  if (importsModule(text, "fastify") || importsModule(text, "fastify-plugin")) for (const n of ["app", "server", "instance"]) receivers.add(n);

  const spans: PluginSpan[] = [];
  const hintsRaw: { callRecv: string; callOffset: number; prefix: string; target: string }[] = [];
  const seenRegister = new Set<number>();
  // Registrations nest (a plugin registers plugins): repeat until no new receiver appears.
  for (let pass = 0; pass < 5; pass++) {
    const before = receivers.size;
    const names = [...receivers].map((r) => r.replace(/\$/g, "\\$")).join("|");
    for (const m of skeleton.matchAll(new RegExp(`(?<![\\w$.])(${names})\\s*\\.\\s*register\\s*\\(`, "g"))) {
      const offset = m.index as number;
      if (seenRegister.has(offset)) continue;
      const call = readArgs(text, offset + m[0].length - 1);
      if (!call?.args[0]) continue;
      seenRegister.add(offset);
      const callRecv = m[1] as string;
      const opts = call.args[1]?.raw.startsWith("{") ? objectProps(text, call.args[1].start) : undefined;
      const prefixRaw = opts ? propValue(opts.props, "prefix")?.value : undefined;
      const prefix = prefixRaw ? (stringLiteral(prefixRaw) ?? "") : "";
      let plugin = call.args[0];
      const wrapped = /^([A-Za-z_$][\w$]*)\s*\(/.exec(plugin.raw);
      if (wrapped && wrappers.has(wrapped[1] as string)) {
        const inner = readArgs(text, plugin.start + wrapped[0].length - 1);
        if (inner?.args[0]) plugin = inner.args[0];
      }
      const inlineParam = firstParam(plugin.raw);
      if (inlineParam && /^(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(plugin.raw)) {
        spans.push({ start: plugin.start, end: plugin.start + plugin.raw.length, param: inlineParam, prefix, callRecv, callOffset: offset });
        receivers.add(inlineParam);
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(plugin.raw)) {
        const name = plugin.raw.replace(/\$/g, "\\$");
        const decl =
          new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(\\s*([A-Za-z_$][\\w$]*)`).exec(skeleton) ??
          new RegExp(
            `\\b(?:const|let|var)\\s+${name}\\s*(?::[^=;]+)?=\\s*(?:[A-Za-z_$][\\w$]*\\s*\\(\\s*)?(?:async\\s+)?(?:function\\s*[\\w$]*\\s*)?\\(\\s*([A-Za-z_$][\\w$]*)`,
          ).exec(skeleton);
        if (decl) {
          const start = decl.index;
          spans.push({ start, end: blockEndFrom(skeleton, start + decl[0].length), param: decl[1] as string, prefix, callRecv, callOffset: offset });
          receivers.add(decl[1] as string);
          continue;
        }
      }
      const target = mountedModule(ctx, input.rel, plugin.raw, imports);
      if (target) hintsRaw.push({ callRecv, callOffset: offset, prefix, target });
    }
    if (receivers.size === before) break;
  }

  const contextPrefixes = (recv: string, offset: number, depth = 0): string[] => {
    const inside = spans.filter((s) => s.param === recv && s.start <= offset && offset < s.end);
    if (!inside.length || depth > 10) return [""];
    const innermost = Math.max(...inside.map((s) => s.start));
    const out = new Set<string>();
    for (const s of inside.filter((x) => x.start === innermost)) {
      for (const outer of contextPrefixes(s.callRecv, s.callOffset, depth + 1)) out.add(joinRoutePath(outer, s.prefix));
    }
    return [...out];
  };

  const routes: RawRoute[] = [];
  const names = [...receivers].map((r) => r.replace(/\$/g, "\\$")).join("|");
  const CALL = new RegExp(`(?<![\\w$.])(${names})\\s*\\.\\s*(get|head|post|put|delete|options|patch|all|route)\\s*\\(`, "g");
  const onCall = (recv: string, name: string, args: Arg[], offset: number): boolean => {
    if (FASTIFY_VERBS.has(name)) {
      const path = args[0] ? stringLiteral(args[0].raw) : undefined;
      if (path === undefined || !isRoutePath(path) || args.length < 2) return false;
      routes.push({ receiver: recv, method: name.toUpperCase(), path, offset, handler: lastHandler(args.slice(1)) });
      return true;
    }
    if (name === "route") {
      if (!args[0]?.raw.startsWith("{")) return false;
      const opts = objectProps(text, args[0].start);
      if (!opts) return false;
      const methods = literalList(propValue(opts.props, "method")?.value ?? "");
      const url = propValue(opts.props, "url") ?? propValue(opts.props, "path");
      const path = url ? stringLiteral(url.value) : undefined;
      if (!methods?.length || path === undefined || !isRoutePath(path)) return false;
      const handlerRaw = propValue(opts.props, "handler")?.value;
      const handler = handlerRaw ? identifierPath(handlerRaw) : undefined;
      for (const method of methods) routes.push({ receiver: recv, method: method.toUpperCase(), path, offset, handler });
      return true;
    }
    return false;
  };
  for (const m of skeleton.matchAll(CALL)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call || !onCall(m[1] as string, m[2] as string, call.args, m.index as number)) continue;
    for (const c of chainAfter(skeleton, text, call.end)) if (!onCall(m[1] as string, c.name, c.args, c.dot)) break;
  }

  const facts = toFacts(input, "fastify", routes, (r) => contextPrefixes(r.receiver, r.offset), lineOf);
  const hints: MountHint[] = [];
  for (const h of hintsRaw) {
    for (const outer of contextPrefixes(h.callRecv, h.callOffset)) {
      hints.push({
        kind: "mount",
        framework: "fastify",
        file: input.rel,
        line: lineOf(h.callOffset),
        prefix: joinRoutePath(outer, h.prefix),
        target: h.target,
      });
    }
  }
  const out: ExtractOutput = {};
  if (facts.length) out.routes = facts;
  if (hints.length) out.hints = hints;
  return out;
}

export const fastifyExtractor: Extractor = {
  id: "fastify",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["fastify"]);
  },
  extract: extractFastify,
};

/** Cross-file Hono `route()` and Fastify `register()` prefixes, on the shared mount machinery (mounts.ts). */
export const jsMountLinker: Linker = {
  id: "js-mounts",
  link(facts, ctx) {
    const files = new Set(ctx.files);
    const resolve = (h: MountHint) => moduleFile(h.target, files);
    return applyMounts(applyMounts(facts, ctx.hints, "hono", resolve), ctx.hints, "fastify", resolve);
  },
};
