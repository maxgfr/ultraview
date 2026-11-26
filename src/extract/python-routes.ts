// Python web routes: FastAPI, Flask, Django URLconfs (and Django REST
// framework routers).
//
//   FastAPI  @app.get("/x"), @router.post(…), @app.api_route("/x", methods=[…])
//            on receivers assigned FastAPI() / APIRouter(prefix="/p");
//            app.include_router(router, prefix="/q") mounts.
//   Flask    @app.route("/x", methods=["GET", "POST"]) (one route per method),
//            @bp.get("/x"), app.add_url_rule("/x", …) on receivers assigned
//            Flask(…) / Blueprint(…, url_prefix="/p");
//            app.register_blueprint(bp, url_prefix="/q") mounts.
//   Django   path("x/<int:id>/", view), re_path(r"^x/(?P<id>\d+)/$", view)
//            (best effort), include("app.urls") / include([...]) prefixes;
//            method ALL, handler = the view; DRF router.register("orders",
//            OrderViewSet) → the standard list and detail routes, trimmed to
//            the viewset's actions (bases, mixins, methods) by a linker.
//
// Same-file mounts are applied here; a mount of another module becomes a
// `MountHint` for the `python-mounts` linker (shared machinery: mounts.ts).
// Every framework is gated on the workspace declaring it.

import { type Arg, readArgs } from "./js.js";
import { lineIndex, maskSource } from "./mask.js";
import { applyMounts, joinRoutePath } from "./mounts.js";
import {
  decoratedName,
  importsPyModule,
  isPython,
  kwarg,
  positional,
  pyDotted,
  pyImports,
  pyImportTarget,
  pyLiteral,
  pyModuleFile,
  pyClasses,
  pyModulePath,
  pyRouteParams,
  pyStringList,
} from "./py.js";
import type { ExtractInput, ExtractOutput, Extractor, Facts, Linker, MountHint, RepoContext, RouteFact, ViewsetHint } from "./types.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Views {
  rel: string;
  /** Comments (and docstrings) blanked: literals are read here. */
  text: string;
  /** Strings blanked too: call sites are searched here. */
  skeleton: string;
  lineOf: (offset: number) => number;
}

function views(input: ExtractInput): Views {
  const text = maskSource(input.rel, input.text);
  return { rel: input.rel, text, skeleton: maskSource(input.rel, input.text, { strings: true }), lineOf: lineIndex(text) };
}

/** A route as seen on one receiver, before that receiver's prefixes are known. */
interface RawRoute {
  receiver: string;
  method: string;
  path: string;
  line: number;
  handler?: string;
}

/** `parent` serves receiver `local` (same file) or module `target` (another file) under `prefix`. */
interface RawMount {
  parent: string;
  prefix: string;
  line: number;
  local?: string;
  target?: string;
  /** Flask: a register-time url_prefix replaces the blueprint's own one. */
  replaces?: boolean;
}

/**
 * Turn per-receiver routes and mounts into facts and hints: a receiver's own
 * prefix, then the prefixes of the same-file receivers that mount it, nested.
 */
function assemble(
  rel: string,
  framework: string,
  ownPrefix: ReadonlyMap<string, string>,
  routes: RawRoute[],
  mounts: RawMount[],
): { routes: RouteFact[]; hints: MountHint[] } {
  const localParents = new Map<string, RawMount[]>();
  for (const mt of mounts) {
    if (!mt.local) continue;
    const list = localParents.get(mt.local) ?? [];
    list.push(mt);
    localParents.set(mt.local, list);
  }
  // Full prefixes a receiver's routes are served under (its own prefix included).
  const prefixesOf = (recv: string, seen: Set<string>): string[] => {
    const own = ownPrefix.get(recv) ?? "";
    const parents = localParents.get(recv);
    if (!parents || seen.has(recv)) return [own];
    const next = new Set(seen).add(recv);
    return parents.flatMap((p) => {
      const base = p.replaces ? p.prefix : joinRoutePath(p.prefix, own);
      return prefixesOf(p.parent, next).map((outer) => joinRoutePath(outer, base));
    });
  };
  const facts: RouteFact[] = [];
  for (const r of routes) {
    for (const prefix of prefixesOf(r.receiver, new Set())) {
      const fact: RouteFact = { method: r.method, path: joinRoutePath(prefix, r.path), file: rel, line: r.line, framework };
      if (r.handler) fact.handler = r.handler;
      facts.push(fact);
    }
  }
  const hints: MountHint[] = [];
  for (const mt of mounts) {
    if (!mt.target) continue;
    for (const outer of prefixesOf(mt.parent, new Set())) {
      const prefix = joinRoutePath(outer, mt.prefix);
      if (prefix !== "/") hints.push({ kind: "mount", framework, file: rel, line: mt.line, prefix, target: mt.target });
    }
  }
  return { routes: facts, hints };
}

function output(r: { routes: RouteFact[]; hints: MountHint[] }): ExtractOutput {
  const out: ExtractOutput = {};
  if (r.routes.length) out.routes = r.routes;
  if (r.hints.length) out.hints = r.hints;
  return out;
}

/** A route path argument: the first positional plain string, or the `path=` / `rule=` keyword. */
function pathArg(args: readonly Arg[], ...names: string[]): string | undefined {
  const first = positional(args)[0];
  const lit = pyLiteral(first?.raw);
  if (lit !== undefined) return lit;
  for (const n of names) {
    const v = pyLiteral(kwarg(args, n)?.raw);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Receivers assigned `<ctor>(…)` (optionally `module.<ctor>(…)`), with the call's `(` offset. */
function assigned(skeleton: string, ctors: string[], modules: string[]): { name: string; ctor: string; open: number }[] {
  const mod = modules.length ? `(?:(?:${modules.map(esc).join("|")})\\s*\\.\\s*)?` : "";
  const re = new RegExp(`^[ \\t]*([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)?)[ \\t]*(?::[^=\\n]+)?=[ \\t]*${mod}(${ctors.join("|")})[ \\t]*\\(`, "gm");
  return [...skeleton.matchAll(re)].map((m) => ({ name: m[1] as string, ctor: m[2] as string, open: (m.index as number) + m[0].length - 1 }));
}

function mountTarget(v: Views, raw: string, receivers: ReadonlySet<string>, imports: ReturnType<typeof pyImports>): { local?: string; target?: string } {
  const dotted = pyDotted(raw);
  if (!dotted) return {};
  if (receivers.has(dotted)) return { local: dotted };
  const target = pyImportTarget(v.rel, dotted, imports);
  return target ? { target } : {};
}

// ---------------------------------------------------------------- FastAPI

const FASTAPI_VERBS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];

function extractFastapi(input: ExtractInput): ExtractOutput {
  const v = views(input);
  const ownPrefix = new Map<string, string>();
  for (const a of assigned(v.skeleton, ["FastAPI", "APIRouter"], ["fastapi"])) {
    const call = readArgs(v.text, a.open);
    ownPrefix.set(a.name, a.ctor === "APIRouter" ? (pyLiteral(call && kwarg(call.args, "prefix")?.raw) ?? "") : "");
  }
  if (!ownPrefix.size && importsPyModule(v.text, "fastapi")) {
    ownPrefix.set("app", "");
    ownPrefix.set("router", "");
  }
  if (!ownPrefix.size) return {};
  const receivers = new Set(ownPrefix.keys());
  const names = [...receivers].map(esc).join("|");
  const routes: RawRoute[] = [];
  const DECO = new RegExp(`^[ \\t]*@[ \\t]*(${names})\\s*\\.\\s*(${FASTAPI_VERBS.join("|")}|api_route)\\s*\\(`, "gm");
  for (const m of v.skeleton.matchAll(DECO)) {
    const open = (m.index as number) + m[0].length - 1;
    const call = readArgs(v.text, open);
    if (!call) continue;
    const path = pathArg(call.args, "path");
    if (path === undefined || (path !== "" && !path.startsWith("/"))) continue;
    const verb = m[2] as string;
    const methods = verb === "api_route" ? (pyStringList(kwarg(call.args, "methods")?.raw ?? '["GET"]') ?? ["GET"]) : [verb];
    const handler = decoratedName(v.skeleton, call.end)?.name;
    const line = v.lineOf(v.skeleton.indexOf("@", m.index as number));
    for (const method of methods) routes.push({ receiver: m[1] as string, method: method.toUpperCase(), path: pyRouteParams(path), line, handler });
  }
  const imports = pyImports(v.text);
  const mounts: RawMount[] = [];
  const INCLUDE = new RegExp(`(?<![\\w.])(${names})\\s*\\.\\s*include_router\\s*\\(`, "g");
  for (const m of v.skeleton.matchAll(INCLUDE)) {
    const call = readArgs(v.text, (m.index as number) + m[0].length - 1);
    const first = call && (positional(call.args)[0] ?? kwarg(call.args, "router"));
    if (!call || !first) continue;
    const prefix = pyLiteral(kwarg(call.args, "prefix")?.raw) ?? "";
    if (prefix && !prefix.startsWith("/")) continue;
    const to = mountTarget(v, first.raw, receivers, imports);
    if (to.local || to.target) mounts.push({ parent: m[1] as string, prefix: pyRouteParams(prefix), line: v.lineOf(m.index as number), ...to });
  }
  return output(assemble(input.rel, "fastapi", ownPrefix, routes, mounts));
}

export const fastapiExtractor: Extractor = {
  id: "fastapi",
  applies: (input: ExtractInput, ctx: RepoContext) => isPython(input.rel) && ctx.depsFor(input.rel).has("fastapi"),
  extract: extractFastapi,
};

// ---------------------------------------------------------------- Flask

const FLASK_VERBS = ["get", "post", "put", "patch", "delete"];

function extractFlask(input: ExtractInput): ExtractOutput {
  const v = views(input);
  const ownPrefix = new Map<string, string>();
  for (const a of assigned(v.skeleton, ["Flask", "Blueprint"], ["flask"])) {
    const call = readArgs(v.text, a.open);
    ownPrefix.set(a.name, a.ctor === "Blueprint" ? (pyLiteral(call && kwarg(call.args, "url_prefix")?.raw) ?? "") : "");
  }
  if (!ownPrefix.size && importsPyModule(v.text, "flask")) {
    ownPrefix.set("app", "");
    ownPrefix.set("bp", "");
  }
  if (!ownPrefix.size) return {};
  const receivers = new Set(ownPrefix.keys());
  const names = [...receivers].map(esc).join("|");
  const routes: RawRoute[] = [];
  const DECO = new RegExp(`^[ \\t]*@[ \\t]*(${names})\\s*\\.\\s*(route|${FLASK_VERBS.join("|")})\\s*\\(`, "gm");
  for (const m of v.skeleton.matchAll(DECO)) {
    const call = readArgs(v.text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    const path = pathArg(call.args, "rule");
    if (path === undefined || !path.startsWith("/")) continue;
    const verb = m[2] as string;
    const methods = verb === "route" ? (pyStringList(kwarg(call.args, "methods")?.raw ?? '["GET"]') ?? ["GET"]) : [verb];
    const handler = decoratedName(v.skeleton, call.end)?.name;
    const line = v.lineOf(v.skeleton.indexOf("@", m.index as number));
    for (const method of methods) routes.push({ receiver: m[1] as string, method: method.toUpperCase(), path: pyRouteParams(path), line, handler });
  }
  const RULE = new RegExp(`(?<![\\w.])(${names})\\s*\\.\\s*add_url_rule\\s*\\(`, "g");
  for (const m of v.skeleton.matchAll(RULE)) {
    const call = readArgs(v.text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    const path = pathArg(call.args, "rule");
    if (path === undefined || !path.startsWith("/")) continue;
    const pos = positional(call.args);
    const view = kwarg(call.args, "view_func")?.raw ?? pos[2]?.raw;
    const handler = view ? pyDotted(view.replace(/\.as_view\s*\([\s\S]*\)$/, "")) : undefined;
    const methods = pyStringList(kwarg(call.args, "methods")?.raw ?? '["GET"]') ?? ["GET"];
    for (const method of methods)
      routes.push({ receiver: m[1] as string, method: method.toUpperCase(), path: pyRouteParams(path), line: v.lineOf(m.index as number), handler });
  }
  const imports = pyImports(v.text);
  const mounts: RawMount[] = [];
  const REGISTER = new RegExp(`(?<![\\w.])(${names})\\s*\\.\\s*register_blueprint\\s*\\(`, "g");
  for (const m of v.skeleton.matchAll(REGISTER)) {
    const call = readArgs(v.text, (m.index as number) + m[0].length - 1);
    const first = call && (positional(call.args)[0] ?? kwarg(call.args, "blueprint"));
    if (!call || !first) continue;
    const given = kwarg(call.args, "url_prefix");
    const prefix = pyLiteral(given?.raw);
    if (given && prefix === undefined) continue;
    const to = mountTarget(v, first.raw, receivers, imports);
    if (to.local)
      mounts.push({
        parent: m[1] as string,
        prefix: pyRouteParams(prefix ?? ""),
        line: v.lineOf(m.index as number),
        local: to.local,
        replaces: prefix !== undefined,
      });
    // Cross-file: the blueprint's own url_prefix is already on its routes, so
    // the register-time prefix composes in front (known gap: Flask lets a
    // register-time url_prefix replace the blueprint's own one).
    else if (to.target) mounts.push({ parent: m[1] as string, prefix: pyRouteParams(prefix ?? ""), line: v.lineOf(m.index as number), target: to.target });
  }
  return output(assemble(input.rel, "flask", ownPrefix, routes, mounts));
}

export const flaskExtractor: Extractor = {
  id: "flask",
  applies: (input: ExtractInput, ctx: RepoContext) => isPython(input.rel) && ctx.depsFor(input.rel).has("flask"),
  extract: extractFlask,
};

// ---------------------------------------------------------------- Django

/** A Django route string as a path: leading slash, params as `:name`, no trailing slash. */
export function djangoPath(route: string): string {
  const p = `/${pyRouteParams(route).replace(/^\/+/, "")}`.replace(/\/+$/, "");
  return p || "/";
}

/** A `re_path` regex as a path, best effort: anchors dropped, named groups → `:name`, other groups → `:p`. Undefined when still a pattern. */
export function djangoRegexPath(regex: string): string | undefined {
  const p = regex
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\(\?P<([A-Za-z_]\w*)>(?:[^()]|\([^()]*\))*\)/g, ":$1")
    .replace(/\((?!\?)(?:[^()]|\([^()]*\))*\)/g, ":p")
    .replace(/\/\?$/, "/")
    .replace(/\\([./-])/g, "$1");
  if (/[\\^$*+?()[\]{}|]/.test(p)) return undefined;
  return djangoPath(p);
}

/** DRF's standard routes for a registered viewset (a ModelViewSet's), trimmed to its real actions by the `drf-viewsets` linker. */
function drfRoutes(prefix: string): { method: string; path: string }[] {
  const list = djangoPath(prefix);
  const detail = joinRoutePath(list, "/:pk");
  return [
    { method: "GET", path: list },
    { method: "POST", path: list },
    { method: "GET", path: detail },
    { method: "PUT", path: detail },
    { method: "PATCH", path: detail },
    { method: "DELETE", path: detail },
  ];
}

const DETAIL_SUFFIX = "/:pk";

/** Actions of DRF's generic bases and mixins, and of the viewset methods that implement them. */
const DRF_BASES: Record<string, { list: string[]; detail: string[] }> = {
  ModelViewSet: { list: ["GET", "POST"], detail: ["GET", "PUT", "PATCH", "DELETE"] },
  ReadOnlyModelViewSet: { list: ["GET"], detail: ["GET"] },
  ListModelMixin: { list: ["GET"], detail: [] },
  CreateModelMixin: { list: ["POST"], detail: [] },
  RetrieveModelMixin: { list: [], detail: ["GET"] },
  UpdateModelMixin: { list: [], detail: ["PUT", "PATCH"] },
  DestroyModelMixin: { list: [], detail: ["DELETE"] },
};
const DRF_METHODS: Record<string, { scope: "list" | "detail"; method: string }> = {
  list: { scope: "list", method: "GET" },
  create: { scope: "list", method: "POST" },
  retrieve: { scope: "detail", method: "GET" },
  update: { scope: "detail", method: "PUT" },
  partial_update: { scope: "detail", method: "PATCH" },
  destroy: { scope: "detail", method: "DELETE" },
};

function extractViewsets(input: ExtractInput): ExtractOutput {
  const v = views(input);
  if (!/ViewSet\b|ModelMixin\b/.test(v.skeleton)) return {};
  const classes = pyClasses(v.skeleton, (open) => readArgs(v.text, open)?.args);
  const known = new Map<string, { list: Set<string>; detail: Set<string> }>();
  const hints: ViewsetHint[] = [];
  for (const cls of classes) {
    const list = new Set<string>();
    const detail = new Set<string>();
    let viewset = false;
    for (const b of cls.bases) {
      const name = b.raw.replace(/\s+/g, "").replace(/^.*\./, "");
      const base = DRF_BASES[name] ?? known.get(name);
      if (base) {
        for (const m of base.list) list.add(m);
        for (const m of base.detail) detail.add(m);
        viewset = true;
      } else if (name === "ViewSet" || name === "GenericViewSet") viewset = true;
    }
    if (!viewset) continue;
    for (const at of cls.statements) {
      const def = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/.exec(v.skeleton.slice(at, at + 200));
      const action = def ? DRF_METHODS[def[1] as string] : undefined;
      if (action) (action.scope === "list" ? list : detail).add(action.method);
    }
    known.set(cls.name, { list, detail });
    hints.push({ kind: "viewset", name: cls.name, list: [...list].sort(), detail: [...detail].sort(), file: input.rel, line: v.lineOf(cls.offset) });
  }
  return hints.length ? { hints } : {};
}

/** DRF viewset classes: what each one serves, for the `drf-viewsets` linker. */
export const drfViewsetExtractor: Extractor = {
  id: "drf-viewsets",
  applies: (input: ExtractInput, ctx: RepoContext) => isPython(input.rel) && ctx.depsFor(input.rel).has("djangorestframework"),
  extract: extractViewsets,
};

/**
 * Trim the standard routes a DRF router registers to what each viewset
 * actually serves (a `ReadOnlyModelViewSet` answers GET only). Viewsets no
 * file declares keep the full ModelViewSet set; a name declared twice serves
 * the union of both.
 */
export const drfViewsetLinker: Linker = {
  id: "drf-viewsets",
  link(facts: Facts, ctx) {
    const served = new Map<string, { list: Set<string>; detail: Set<string> }>();
    for (const h of ctx.hints) {
      if (h.kind !== "viewset") continue;
      const s = served.get(h.name) ?? { list: new Set<string>(), detail: new Set<string>() };
      for (const m of h.list) s.list.add(m);
      for (const m of h.detail) s.detail.add(m);
      served.set(h.name, s);
    }
    if (!served.size) return facts;
    const routes = facts.routes.filter((r) => {
      const s = r.framework === "django" && r.method !== "ALL" && r.handler ? served.get(r.handler) : undefined;
      if (!s) return true;
      return (r.path.endsWith(DETAIL_SUFFIX) ? s.detail : s.list).has(r.method);
    });
    return { ...facts, routes };
  },
};

function extractDjango(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const v = views(input);
  if (!/\burlpatterns\b/.test(v.skeleton)) return {};
  const imports = pyImports(v.text);
  // `path` / `re_path` / `url` / `include` count only when imported from Django.
  const fromDjango = (name: string) => {
    const imp = imports.get(name);
    return !!imp && (imp.module === "django.urls" || imp.module === "django.conf.urls");
  };
  const routeFns = ["path", "re_path", "url"].filter(fromDjango);
  const includeName = [...imports.entries()].find(
    ([, imp]) => imp.name === "include" && (imp.module === "django.urls" || imp.module === "django.conf.urls"),
  )?.[0];
  const drf = ctx.depsFor(input.rel).has("djangorestframework");
  const routers = drf ? assigned(v.skeleton, ["DefaultRouter", "SimpleRouter"], ["routers"]).map((a) => a.name) : [];
  if (!routeFns.length && !routers.length) return {};

  interface Region {
    start: number;
    end: number;
    prefix: string;
  }
  interface Pending {
    offset: number;
    path: string;
    handler?: string;
  }
  const regions: Region[] = [];
  const plain: Pending[] = [];
  const hints: MountHint[] = [];
  const pendingHints: { offset: number; prefix: string; target: string }[] = [];
  const routerPrefixes = new Map<string, { offset: number; prefix: string }[]>();

  if (routeFns.length) {
    const CALL = new RegExp(`(?<![\\w.])(${routeFns.map(esc).join("|")})\\s*\\(`, "g");
    for (const m of v.skeleton.matchAll(CALL)) {
      const call = readArgs(v.text, (m.index as number) + m[0].length - 1);
      if (!call) continue;
      const pos = positional(call.args);
      const routeArg = pos[0] ?? kwarg(call.args, "route");
      const view = pos[1] ?? kwarg(call.args, "view");
      if (!routeArg || !view) continue;
      const lit = pyLiteral(routeArg.raw);
      if (lit === undefined) continue;
      const path = m[1] === "path" ? djangoPath(lit) : djangoRegexPath(lit);
      if (path === undefined) continue;
      const inc = includeName ? new RegExp(`^${esc(includeName)}\\s*\\(`).exec(view.raw) : null;
      if (inc) {
        const inner = readArgs(v.text, view.start + inc[0].length - 1);
        let target = inner && positional(inner.args)[0];
        if (!target) continue;
        // include(("app.urls", "ns")) — the module is the tuple's first item.
        if (target.raw.startsWith("(")) {
          const tuple = readArgs(v.text, target.start);
          target = tuple?.args[0];
          if (!target) continue;
        }
        const module = pyLiteral(target.raw);
        if (module !== undefined) pendingHints.push({ offset: m.index as number, prefix: path, target: pyModulePath(input.rel, module) });
        else if (target.raw.startsWith("[")) regions.push({ start: target.start, end: target.start + target.raw.length, prefix: path });
        else {
          const dotted = pyDotted(target.raw);
          const router = dotted?.endsWith(".urls") ? dotted.slice(0, -".urls".length) : undefined;
          if (router && routers.includes(router)) {
            const list = routerPrefixes.get(router) ?? [];
            list.push({ offset: m.index as number, prefix: path });
            routerPrefixes.set(router, list);
          } else if (dotted) {
            const t = pyImportTarget(input.rel, dotted, imports);
            if (t) pendingHints.push({ offset: m.index as number, prefix: path, target: t });
          }
        }
        continue;
      }
      const handler = pyDotted(view.raw.replace(/\.as_view\s*\([\s\S]*\)$/, ""));
      plain.push({ offset: m.index as number, path, handler });
    }
  }

  // Prefixes of the inline include([...]) lists enclosing an offset, outermost first.
  const enclosing = (offset: number): string => {
    let prefix = "";
    for (const r of [...regions].sort((a, b) => a.start - b.start)) if (offset > r.start && offset < r.end) prefix = joinRoutePath(prefix, r.prefix);
    return prefix;
  };
  const routes: RouteFact[] = [];
  for (const p of plain) {
    const fact: RouteFact = { method: "ALL", path: joinRoutePath(enclosing(p.offset), p.path), file: input.rel, line: v.lineOf(p.offset), framework: "django" };
    if (p.handler) fact.handler = p.handler;
    routes.push(fact);
  }
  for (const h of pendingHints) {
    const prefix = joinRoutePath(enclosing(h.offset), h.prefix);
    if (prefix !== "/") hints.push({ kind: "mount", framework: "django", file: input.rel, line: v.lineOf(h.offset), prefix, target: h.target });
  }
  if (routers.length) {
    const REGISTER = new RegExp(`(?<![\\w.])(${routers.map(esc).join("|")})\\s*\\.\\s*register\\s*\\(`, "g");
    for (const m of v.skeleton.matchAll(REGISTER)) {
      const call = readArgs(v.text, (m.index as number) + m[0].length - 1);
      if (!call) continue;
      const pos = positional(call.args);
      const prefix = pyLiteral((pos[0] ?? kwarg(call.args, "prefix"))?.raw);
      const viewset = pyDotted((pos[1] ?? kwarg(call.args, "viewset"))?.raw ?? "");
      if (prefix === undefined || !viewset) continue;
      const mounted = routerPrefixes.get(m[1] as string) ?? [{ offset: -1, prefix: "" }];
      for (const at of mounted) {
        const outer = at.offset === -1 ? "" : joinRoutePath(enclosing(at.offset), at.prefix);
        for (const r of drfRoutes(prefix)) {
          routes.push({
            method: r.method,
            path: joinRoutePath(outer, r.path),
            file: input.rel,
            line: v.lineOf(m.index as number),
            framework: "django",
            handler: viewset,
          });
        }
      }
    }
  }
  return output({ routes, hints });
}

export const djangoUrlsExtractor: Extractor = {
  id: "django-urls",
  applies: (input: ExtractInput, ctx: RepoContext) => isPython(input.rel) && ctx.depsFor(input.rel).has("django"),
  extract: extractDjango,
};

/**
 * Cross-file Python mounts, through the shared mounts.ts machinery:
 * FastAPI `include_router`, Flask `register_blueprint` and Django `include`
 * of a module defined in another file. Targets are module paths resolved by
 * `pyModuleFile` (repo root first, then the mounting file's ancestors).
 */
export const pythonMountLinker: Linker = {
  id: "python-mounts",
  link(facts: Facts, ctx) {
    const files = new Set(ctx.files);
    const resolve = (h: MountHint) => pyModuleFile(h.target, h.file, files);
    let out = facts;
    for (const framework of ["django", "fastapi", "flask"]) out = applyMounts(out, ctx.hints, framework, resolve);
    return out;
  },
};
