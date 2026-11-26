// RPC endpoints and the calls that reach them: tRPC procedures and Next.js
// server actions. Apps built on them talk to themselves without a single
// `fetch`, so without these the UI → server flow is invisible.
//
// tRPC (workspace declares an `@trpc/*` package)
//   routes   `router({ … })`, `t.router({ … })`, `createTRPCRouter({ … })`
//            (and same-file aliases `const r = t.router`): each
//            `<x>Procedure….query(…)` / `.mutation(…)` / `.subscription(…)`
//            value is a procedure, its key the path; an inline sub-router
//            nests its keys (`posts: router({ list: … })` → `posts.list`); an
//            identifier value (`user: userRouter`, same file or imported) is a
//            child router composed under the key; `mergeRouters(a, b)` merges
//            at the same level. The extractor leaves one `rpc-router` hint
//            per router; the `rpc` linker composes them across files into
//            full paths and emits `RouteFact { method: QUERY | MUTATION |
//            SUBSCRIPTION, path: "user.byId", framework: "trpc" }`.
//   calls    on a tRPC client (`api` / `trpc` imported from a local module, or
//            a local `createTRPCReact()` / `createTRPCClient()` / `useTRPC()`
//            / `createCaller()` result): `x.user.byId.useQuery(…)`,
//            `.useSuspenseQuery`, `.useInfiniteQuery`, `.query`,
//            `.queryOptions`, `.prefetch`, `.fetch` → QUERY;
//            `.useMutation`, `.mutate`, `.mutationOptions` → MUTATION;
//            `.useSubscription`, `.subscribe` → SUBSCRIPTION. Cache helpers
//            (`invalidate`, `setData`, `queryKey`, …) are not calls. A call
//            without a terminal (`await api.user.byId({ id })`, a server-side
//            caller) is a call when a procedure of exactly that path exists,
//            with its method.
//
// Next server actions (workspace declares `next`)
//   routes   a file whose first statement is `"use server"`: every export is
//            an action (Next requires them all to be async functions);
//            a function whose body starts with `"use server"` is one too.
//            `RouteFact { method: "ACTION", path: "<repo path without
//            extension>#<export>", framework: "next-action" }`.
//   calls    a function imported from a local module (relative, or the `@/`,
//            `~/`, `#`, `$lib` aliases, resolved against the workspace root,
//            its `src/` and `app/`; tsconfig `paths` are not read) and called,
//            passed as `action={fn}` / `formAction={fn}` (`.bind(…)`
//            included), or to `useActionState` / `useFormState` /
//            `useAction`: an `action-call` hint, an `ACTION` call when the
//            module exports an action by that name. Same-file inline actions
//            passed as `action={fn}` are calls directly. A server-only
//            module (`"use server"`, an app-router page / layout / route, a
//            `server-only` import, an async component) runs an action it
//            calls in-process: only its `action={fn}` forms count.
//
// Known gaps: tRPC v9 string paths (`useQuery(["user.byId"])`), routers
// re-exported through barrels, procedures built by helper functions; server
// actions re-exported through barrels or passed around as props.

import { readArgs } from "./js.js";
import { declares, exportedNames, importBindings, isLocalSpecifier, isScriptFile, objectProps, resolveLocalModule, sourceViews } from "./source.js";
import type {
  ActionCallHint,
  CallFact,
  ExtractInput,
  ExtractOutput,
  Extractor,
  Facts,
  LinkContext,
  Linker,
  RepoContext,
  RouteFact,
  RpcCallHint,
  RpcChild,
  RpcProcedure,
  RpcRouterHint,
} from "./types.js";

const IDENT = /^[A-Za-z_$][\w$]*$/;
const STRIP_EXT = /\.(?:[cm]?[jt]sx?)$/;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function joinRpcPath(prefix: string, path: string): string {
  return prefix && path ? `${prefix}.${path}` : prefix || path;
}

// --- tRPC routers --------------------------------------------------------------

const PROCEDURE_METHODS: Record<string, RpcProcedure["method"]> = { query: "QUERY", mutation: "MUTATION", subscription: "SUBSCRIPTION" };

/** The method of a procedure value (`publicProcedure.input(…).query(…)`): its last top-level `.query` / `.mutation` / `.subscription` call. */
export function procedureMethod(skValue: string): RpcProcedure["method"] | undefined {
  const head = /^[A-Za-z_$][\w$]*/.exec(skValue)?.[0];
  if (!head) return undefined;
  let depth = 0;
  let method: RpcProcedure["method"] | undefined;
  let builder = /procedure/i.test(head);
  for (let i = head.length; i < skValue.length; i++) {
    const ch = skValue[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "." && depth === 0) {
      const m = /^\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>\s*)?(\()?/.exec(skValue.slice(i, i + 80));
      if (!m) continue;
      const name = m[1] as string;
      if (!m[2]) {
        if (/procedure/i.test(name)) builder = true;
      } else if (name in PROCEDURE_METHODS) method = PROCEDURE_METHODS[name];
      else if (/^(?:input|output|use|meta|concat|unstable_concat)$/.test(name)) builder = true;
    }
  }
  return builder ? method : undefined;
}

const ROUTER_CALLEES = ["router", "createTRPCRouter", "createRouter"];

/** Same-file router builder aliases: `export const createTRPCRouter = t.router`. */
function routerAliases(skeleton: string): string[] {
  const out: string[] = [];
  for (const m of skeleton.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*router\s*;?\s*(?:\n|$)/g)) out.push(m[1] as string);
  return out;
}

/** The binding a router call is assigned to: `const x = router(…)` → x, `export default router(…)` → default. */
function declarationBefore(skeleton: string, at: number): string | undefined {
  const before = skeleton.slice(Math.max(0, at - 200), at);
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*$/.exec(before);
  if (decl) return decl[1];
  return /\bexport\s+default\s+$/.test(before) ? "default" : undefined;
}

function extractTrpcRouters(input: ExtractInput, ctx: RepoContext): RpcRouterHint[] {
  const { text, skeleton, lineOf } = sourceViews(input);
  const callees = [...ROUTER_CALLEES, ...routerAliases(skeleton)].map((n) => n.replace(/\$/g, "\\$"));
  const head = `(?<![\\w$])(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*router|${callees.join("|")})\\s*\\(\\s*\\{`;
  const ROUTER = new RegExp(head, "g");
  const ROUTER_AT_START = new RegExp(`^${head}`);
  const bindings = importBindings(text);
  const declaredHere = new Set<string>();
  for (const m of skeleton.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) declaredHere.add(m[1] as string);

  const childRef = (ident: string): { module: string; name: string } | undefined => {
    const b = bindings.get(ident);
    if (b) {
      if (b.imported === "*" || !isLocalSpecifier(b.spec)) return undefined;
      const module = resolveLocalModule(ctx, input.rel, b.spec);
      return module ? { module, name: b.imported } : undefined;
    }
    return declaredHere.has(ident) ? { module: input.rel, name: ident } : undefined;
  };

  const parse = (brace: number, prefix: string, procedures: RpcProcedure[], children: RpcChild[], depth: number) => {
    const obj = objectProps(text, brace);
    if (!obj || depth > 8) return;
    for (const p of obj.props) {
      if (!p.key) continue;
      const path = joinRpcPath(prefix, p.key);
      const skValue = skeleton.slice(p.start, p.start + p.value.length);
      if (IDENT.test(p.value)) {
        const ref = childRef(p.value);
        if (ref) children.push({ prefix: path, ...ref });
        continue;
      }
      const nested = ROUTER_AT_START.exec(skValue);
      if (nested) {
        parse(p.start + nested[0].length - 1, path, procedures, children, depth + 1);
        continue;
      }
      const method = procedureMethod(skValue);
      if (method) procedures.push({ path, method, line: lineOf(p.at) });
    }
  };

  const exportsOf = (name: string): string[] => {
    if (name === "default") return ["default"];
    const out = exportedNames(skeleton)
      .filter((e) => e.local === name)
      .map((e) => e.name);
    const def = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*(?:\n|$)/.exec(skeleton);
    if (def?.[1] === name) out.push("default");
    return [...new Set(out)].sort();
  };

  const hints: RpcRouterHint[] = [];
  for (const m of skeleton.matchAll(ROUTER)) {
    const at = m.index as number;
    const name = declarationBefore(skeleton, at);
    if (!name) continue;
    const procedures: RpcProcedure[] = [];
    const children: RpcChild[] = [];
    parse(at + m[0].length - 1, "", procedures, children, 0);
    hints.push({ kind: "rpc-router", file: input.rel, line: lineOf(at), name, exports: exportsOf(name), procedures, children });
  }
  // `const appRouter = t.mergeRouters(a, b)`: children at the same level.
  for (const m of skeleton.matchAll(/(?<![\w$])(?:[A-Za-z_$][\w$]*\s*\.\s*)?mergeRouters\s*\(/g)) {
    const at = m.index as number;
    const name = declarationBefore(skeleton, at);
    const call = readArgs(text, at + m[0].length - 1);
    if (!name || !call) continue;
    const children: RpcChild[] = [];
    for (const a of call.args) {
      const ref = IDENT.test(a.raw) ? childRef(a.raw) : undefined;
      if (ref) children.push({ prefix: "", ...ref });
    }
    hints.push({ kind: "rpc-router", file: input.rel, line: lineOf(at), name, exports: exportsOf(name), procedures: [], children });
  }
  return hints;
}

// --- tRPC calls -----------------------------------------------------------------

const CALL_TERMINALS: Record<string, CallFact["method"]> = {
  useQuery: "QUERY",
  useSuspenseQuery: "QUERY",
  useInfiniteQuery: "QUERY",
  useSuspenseInfiniteQuery: "QUERY",
  usePrefetchQuery: "QUERY",
  usePrefetchInfiniteQuery: "QUERY",
  query: "QUERY",
  queryOptions: "QUERY",
  infiniteQueryOptions: "QUERY",
  prefetch: "QUERY",
  prefetchInfinite: "QUERY",
  fetch: "QUERY",
  fetchInfinite: "QUERY",
  ensureData: "QUERY",
  useMutation: "MUTATION",
  mutate: "MUTATION",
  mutationOptions: "MUTATION",
  useSubscription: "SUBSCRIPTION",
  subscribe: "SUBSCRIPTION",
  subscriptionOptions: "SUBSCRIPTION",
};

/** Client members that are cache or setup helpers, never a request. */
const NOT_A_CALL = new Set([
  "invalidate",
  "refetch",
  "cancel",
  "reset",
  "getData",
  "setData",
  "getInfiniteData",
  "setInfiniteData",
  "queryKey",
  "queryFilter",
  "infiniteQueryKey",
  "infiniteQueryFilter",
  "pathKey",
  "pathFilter",
  "mutationKey",
  "useUtils",
  "useContext",
  "useQueries",
  "useSuspenseQueries",
  "createClient",
  "withTRPC",
  "Provider",
  "TRPCProvider",
]);

/** Conventional client names (`api` in create-t3-app, `trpc` elsewhere), trusted only when imported from a local module. */
const CLIENT_NAMES = new Set(["api", "trpc", "client", "caller", "serverClient", "trpcClient"]);

function trpcReceivers(text: string, skeleton: string): string[] {
  const out = new Set<string>();
  for (const [local, b] of importBindings(text)) if (CLIENT_NAMES.has(local) && b.imported !== "*" && isLocalSpecifier(b.spec)) out.add(local);
  const CREATE =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:await\s+)?(?:[A-Za-z_$][\w$.]*\.)?(?:createTRPC\w*|useTRPC\w*|createCaller|createTRPCOptionsProxy)\s*(?:<[^()]*>)?\s*\(/g;
  for (const m of skeleton.matchAll(CREATE)) out.add(m[1] as string);
  return [...out].sort();
}

function extractTrpcCalls(input: ExtractInput): { calls: CallFact[]; hints: RpcCallHint[] } {
  const { text, skeleton, lineOf } = sourceViews(input);
  const calls: CallFact[] = [];
  const hints: RpcCallHint[] = [];
  const receivers = trpcReceivers(text, skeleton);
  if (!receivers.length) return { calls, hints };
  const alt = receivers.map((n) => n.replace(/\$/g, "\\$")).join("|");
  const CALL = new RegExp(`(?<![\\w$.])(?:${alt})((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)\\s*(?:<[^()]*>)?\\s*\\(`, "g");
  for (const m of skeleton.matchAll(CALL)) {
    const segs = (m[1] as string)
      .split(".")
      .map((s) => s.replace(/[\s?]/g, ""))
      .filter(Boolean);
    const terminal = segs[segs.length - 1] as string;
    const line = lineOf(m.index as number);
    if (NOT_A_CALL.has(terminal)) continue;
    const method = CALL_TERMINALS[terminal];
    if (method) {
      if (segs.length >= 2) calls.push({ method, url: segs.slice(0, -1).join("."), file: input.rel, line });
      continue;
    }
    if (segs.length >= 2) hints.push({ kind: "rpc-call", file: input.rel, line, path: segs.join(".") });
  }
  return { calls, hints };
}

const TRPC_PACKAGES = ["@trpc/"];

export const trpcExtractor: Extractor = {
  id: "trpc",
  applies: (input, ctx) => isScriptFile(input.rel) && declares(ctx, input.rel, TRPC_PACKAGES),
  extract(input, ctx) {
    const out: ExtractOutput = {};
    const routers = /\brouter\b|Router\s*\(|mergeRouters/.test(input.text) ? extractTrpcRouters(input, ctx) : [];
    const { calls, hints } = extractTrpcCalls(input);
    if (calls.length) out.calls = calls;
    if (routers.length || hints.length) out.hints = [...routers, ...hints];
    return out;
  },
};

// --- Next server actions --------------------------------------------------------

/** Does the module start with a `"use server"` directive (comments and other directives before it allowed)? */
export function hasDirective(text: string, directive: string): boolean {
  const re = /^\s*(["'])([^"'\n]*)\1\s*;?/;
  let rest = text;
  for (let i = 0; i < 4; i++) {
    const m = re.exec(rest);
    if (!m) return false;
    if (m[2] === directive) return true;
    rest = rest.slice(m[0].length);
  }
  return false;
}

/** The action path of an export: `app/actions.ts` + `save` → `app/actions#save`. */
export function actionPath(rel: string, name: string): string {
  return `${rel.replace(STRIP_EXT, "")}#${name}`;
}

/** Functions whose body starts with `"use server"`: `async function save() { "use server"; … }`, `const save = async () => { "use server" }`. */
function inlineActions(text: string, skeleton: string): { name: string; offset: number }[] {
  const out: { name: string; offset: number }[] = [];
  for (const m of text.matchAll(/(["'])use server\1/g)) {
    const at = m.index as number;
    if (skeleton[at] !== m[1] || skeleton[at + 11] !== m[1]) continue;
    const brace = skeleton.slice(0, at).trimEnd();
    if (!brace.endsWith("{")) continue;
    const open = brace.length - 1;
    const win = skeleton.slice(Math.max(0, open - 600), open);
    const base = Math.max(0, open - 600);
    const fn = [...win.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)].pop();
    const arrow = [...win.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*async\s*(\(|[A-Za-z_$][\w$]*\s*=>)/g)].pop();
    const candidates: { name: string; offset: number; tailFrom: number; arrow: boolean }[] = [];
    if (fn) {
      const call = readArgs(skeleton, base + (fn.index as number) + fn[0].length - 1);
      if (call) candidates.push({ name: fn[1] as string, offset: base + (fn.index as number), tailFrom: call.end, arrow: false });
    }
    if (arrow) {
      const idx = base + (arrow.index as number);
      if ((arrow[2] as string).startsWith("(")) {
        const call = readArgs(skeleton, idx + arrow[0].length - 1);
        if (call) candidates.push({ name: arrow[1] as string, offset: idx, tailFrom: call.end, arrow: true });
      } else candidates.push({ name: arrow[1] as string, offset: idx, tailFrom: idx + arrow[0].length, arrow: true });
    }
    for (const c of candidates.sort((a, b) => b.offset - a.offset)) {
      const tail = skeleton.slice(c.tailFrom, open);
      const ok = c.arrow ? /^\s*(?::[^{};=]*)?=>\s*$/.test(tail) || /^\s*$/.test(tail) : /^\s*(?::[^{};=]*)?$/.test(tail);
      if (ok) {
        out.push({ name: c.name, offset: c.offset });
        break;
      }
    }
  }
  return out;
}

const ACTION_HOOKS = "useActionState|useFormState|useAction|useOptimisticAction|useServerAction|useStateAction";

/** App-router files that always render on the server (unless marked `"use client"`). */
const SERVER_FILES = /(?:^|\/)(?:page|layout|template|default|not-found|route|opengraph-image|twitter-image|icon|sitemap|robots)\.[cm]?[jt]sx?$/;

/**
 * A module that runs on the server only: an app-router page / layout / route
 * file, a module importing `server-only`, or one exporting an async component
 * (`export default async function`, `export const Stats = async () => …`) —
 * client components cannot be async. Never a `"use client"` module.
 */
export function isServerOnlyModule(rel: string, text: string, skeleton: string): boolean {
  if (hasDirective(text, "use client")) return false;
  if (SERVER_FILES.test(rel)) return true;
  if (/\bimport\s+["']server-only["']/.test(text)) return true;
  return /\bexport\s+(?:default\s+async\s+function\b|async\s+function\s+[A-Z]|const\s+[A-Z][\w$]*\s*(?::[^=;]+)?=\s*async\b)/.test(skeleton);
}

function extractNextActions(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  const routes: RouteFact[] = [];
  const calls: CallFact[] = [];
  const hints: ActionCallHint[] = [];
  const serverModule = hasDirective(text, "use server");
  const route = (name: string, handler: string, offset: number) =>
    routes.push({ method: "ACTION", path: actionPath(input.rel, name), file: input.rel, line: lineOf(offset), framework: "next-action", handler });

  if (serverModule) {
    const seen = new Set<string>();
    for (const e of exportedNames(skeleton)) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      route(e.name, e.local, e.offset);
    }
    const def = /\bexport\s+default\s+(?:async\s+)?(?:function\b|\(|[A-Za-z_$])/.exec(skeleton);
    if (def && !seen.has("default")) route("default", "default", def.index);
  }
  const inline = /use server/.test(text) ? inlineActions(text, skeleton) : [];
  for (const a of inline) if (!serverModule || !routes.some((r) => r.handler === a.name)) route(a.name, a.name, a.offset);

  // Same-file inline actions handed to a form.
  for (const a of inline) {
    const esc = a.name.replace(/\$/g, "\\$");
    for (const m of skeleton.matchAll(new RegExp(`\\b(?:action|formAction)\\s*=\\s*\\{\\s*${esc}\\b`, "g"))) {
      const path = actionPath(input.rel, a.name);
      calls.push({ method: "ACTION", url: path, file: input.rel, line: lineOf(m.index as number), route: `route:ACTION ${path}` });
    }
  }

  // Imported functions used as actions: settled by the linker against the action routes.
  // A server-only module calling an action runs it in-process: only its forms post to it.
  if (!serverModule) {
    const serverOnly = isServerOnlyModule(input.rel, text, skeleton);
    const FORM_BEFORE = new RegExp(`\\b(?:action|formAction)\\s*=\\s*\\{\\s*$|\\b(?:${ACTION_HOOKS})\\s*(?:<[^()]*>)?\\s*\\(\\s*$`);
    for (const [local, b] of importBindings(text)) {
      if (!isLocalSpecifier(b.spec)) continue;
      const module = resolveLocalModule(ctx, input.rel, b.spec);
      if (!module || module === input.rel) continue;
      const esc = local.replace(/\$/g, "\\$");
      const USE =
        b.imported === "*"
          ? new RegExp(`(?<![\\w$.])${esc}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*(\\(|\\.\\s*bind\\s*\\(|[},)])`, "g")
          : new RegExp(`(?<![\\w$.])${esc}()\\s*(\\(|\\.\\s*bind\\s*\\(|[},)])`, "g");
      for (const m of skeleton.matchAll(USE)) {
        const at = m.index as number;
        const before = skeleton.slice(Math.max(0, at - 60), at);
        if (/\b(?:function|new)\s*\*?\s*$/.test(before)) continue;
        const form = FORM_BEFORE.test(before);
        const invoked = (m[2] as string).startsWith("(");
        // `x}` / `x,` / `x)` only count as the value of `action={…}` or a hook's first argument.
        if (!form && !invoked && !(m[2] as string).includes("bind")) continue;
        if (!form && serverOnly) continue;
        hints.push({ kind: "action-call", file: input.rel, line: lineOf(at), module, name: b.imported === "*" ? (m[1] as string) : b.imported });
      }
    }
  }

  const out: ExtractOutput = {};
  if (routes.length) out.routes = routes;
  if (calls.length) out.calls = calls;
  if (hints.length) out.hints = hints;
  return out;
}

export const nextActionsExtractor: Extractor = {
  id: "next-actions",
  applies: (input, ctx) => isScriptFile(input.rel) && declares(ctx, input.rel, ["next"]),
  extract: extractNextActions,
};

// --- linker ---------------------------------------------------------------------

/** Full procedure paths of every router: roots (composed by no other router) at "", children under their parents' keys. Cycles cut. */
function composeTrpcRoutes(hints: readonly RpcRouterHint[]): RouteFact[] {
  const key = (file: string, name: string) => `${file}\u0000${name}`;
  const byKey = new Map<string, RpcRouterHint>();
  const byExport = new Map<string, string>();
  for (const h of [...hints].sort((a, b) => cmp(a.file, b.file) || a.line - b.line)) {
    const k = key(h.file, h.name);
    if (byKey.has(k)) continue;
    byKey.set(k, h);
    for (const e of h.exports) if (!byExport.has(key(h.file, e))) byExport.set(key(h.file, e), k);
  }
  const resolve = (c: RpcChild): string | undefined => {
    const local = key(c.module, c.name);
    return byKey.has(local) ? local : byExport.get(local);
  };
  const parents = new Map<string, { parent: string; prefix: string }[]>();
  for (const [k, h] of byKey) {
    for (const c of h.children) {
      const child = resolve(c);
      if (!child || child === k) continue;
      const list = parents.get(child) ?? [];
      list.push({ parent: k, prefix: c.prefix });
      parents.set(child, list);
    }
  }
  const prefixesOf = (k: string, seen: Set<string>): string[] => {
    const list = parents.get(k);
    if (!list) return [""];
    if (seen.has(k)) return [];
    const next = new Set(seen).add(k);
    const out = new Set<string>();
    for (const p of list) for (const outer of prefixesOf(p.parent, next)) out.add(joinRpcPath(outer, p.prefix));
    return [...out].sort();
  };
  const routes: RouteFact[] = [];
  for (const [k, h] of byKey) {
    if (!h.procedures.length) continue;
    for (const prefix of prefixesOf(k, new Set())) {
      for (const p of h.procedures) routes.push({ method: p.method, path: joinRpcPath(prefix, p.path), file: h.file, line: p.line, framework: "trpc" });
    }
  }
  return routes;
}

const RPC_METHODS = new Set(["QUERY", "MUTATION", "SUBSCRIPTION", "ACTION"]);

/**
 * Compose tRPC routers into procedure routes; settle tRPC calls (terminal-less
 * ones take the method of the procedure of that exact path) and server-action
 * uses (imported name → the action the module exports); match every RPC call
 * to its route by exact method + path.
 */
export const rpcLinker: Linker = {
  id: "rpc",
  link(facts: Facts, ctx: LinkContext): Facts {
    const routerHints = ctx.hints.filter((h): h is RpcRouterHint => h.kind === "rpc-router");
    const routes = routerHints.length ? [...facts.routes, ...composeTrpcRoutes(routerHints)] : facts.routes;
    const hasRpc = routerHints.length > 0 || facts.routes.some((r) => r.method === "ACTION") || facts.calls.some((c) => RPC_METHODS.has(c.method));
    if (!hasRpc) return facts;

    const byPath = new Map<string, RouteFact>();
    const trpcByPath = new Map<string, RouteFact>();
    const actions = new Map<string, RouteFact>();
    for (const r of [...routes].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.method, b.method))) {
      if (!RPC_METHODS.has(r.method)) continue;
      const k = `${r.method} ${r.path}`;
      if (!byPath.has(k)) byPath.set(k, r);
      if (r.framework === "trpc" && !trpcByPath.has(r.path)) trpcByPath.set(r.path, r);
      if (r.method === "ACTION") actions.set(`${r.file}\u0000${r.path.slice(r.path.lastIndexOf("#") + 1)}`, r);
    }
    const calls: CallFact[] = [];
    for (const c of facts.calls) {
      if (c.route !== undefined || !RPC_METHODS.has(c.method)) {
        calls.push(c);
        continue;
      }
      const r = byPath.get(`${c.method} ${c.url}`);
      calls.push(r ? { ...c, route: `route:${r.method} ${r.path}` } : c);
    }
    for (const h of ctx.hints) {
      if (h.kind === "rpc-call") {
        const r = trpcByPath.get(h.path);
        if (r) calls.push({ method: r.method, url: r.path, file: h.file, line: h.line, route: `route:${r.method} ${r.path}` });
      } else if (h.kind === "action-call") {
        const r = actions.get(`${h.module}\u0000${h.name}`);
        if (r) calls.push({ method: "ACTION", url: r.path, file: h.file, line: h.line, route: `route:ACTION ${r.path}` });
      }
    }
    return { ...facts, routes, calls };
  },
};
