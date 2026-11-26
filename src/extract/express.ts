// Express routes.
//
// Recognizes, on receivers that are provably Express apps or routers:
//   app.get("/x", handler)            (get post put patch delete all options head)
//   router.route("/x").get(h).post(h)
//   app.use("/api", router)           same-file mounts are applied here;
//                                     cross-file mounts become hints for the
//                                     `express-mounts` linker.
//
// A receiver is provably Express when it is assigned `express()`,
// `express.Router()` or `Router()`, or is a parameter typed `Express`,
// `Application` or `Router`. When a file imports express but declares none,
// the conventional names `app` and `router` are accepted. Files outside a
// workspace that depends on express are never read.

import { lineIndex, maskSource } from "./mask.js";
import { applyMounts, joinRoutePath } from "./mounts.js";
import { identifierPath, importsModule, isJsLike, moduleFile, readArgs, relativeImports, resolveRelative, stringLiteral } from "./js.js";
import type { ExtractInput, ExtractOutput, Extractor, Facts, Linker, MountHint, RepoContext, RouteFact } from "./types.js";

export { joinRoutePath } from "./mounts.js";

const FRAMEWORK = "express";
const VERBS = ["get", "post", "put", "patch", "delete", "all", "options", "head"] as const;
const VERB_SET = new Set<string>(VERBS);

function receiversOf(skeleton: string, code: string): Set<string> {
  const out = new Set<string>();
  const ASSIGN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+\s*)?=\s*(?:express\s*\(\s*\)|express\s*\.\s*Router\s*\(|Router\s*\()/g;
  for (const m of skeleton.matchAll(ASSIGN)) out.add(m[1] as string);
  const TYPED = /\b([A-Za-z_$][\w$]*)\s*:\s*(?:express\s*\.\s*)?(?:Express|Application|Router)\b(?!\s*\()/g;
  for (const m of skeleton.matchAll(TYPED)) out.add(m[1] as string);
  if (!out.size && importsModule(code, "express")) {
    out.add("app");
    out.add("router");
  }
  return out;
}

function isRoutePath(path: string): boolean {
  return path.startsWith("/") || path === "*";
}

interface RawRoute {
  receiver: string;
  method: string;
  path: string;
  line: number;
  /** Line of the registering call's closing parenthesis. */
  end: number;
  handler?: string;
}

interface RawMount {
  parent: string;
  prefix: string;
  line: number;
  /** A receiver of this file mounted under `prefix`. */
  local?: string;
  /** A module path mounted under `prefix`. */
  target?: string;
}

function lastHandler(args: { raw: string }[]): string | undefined {
  const last = args[args.length - 1];
  return last ? identifierPath(last.raw) : undefined;
}

function extractExpress(input: ExtractInput): ExtractOutput {
  // Search the skeleton (comments and string contents blanked), read literals
  // from `text` (comments blanked only): same offsets in both.
  const text = maskSource(input.rel, input.text);
  const skeleton = maskSource(input.rel, input.text, { strings: true });
  const receivers = receiversOf(skeleton, text);
  if (!receivers.size) return {};
  const lineOf = lineIndex(text);
  const names = [...receivers].map((r) => r.replace(/\$/g, "\\$")).join("|");
  const imports = relativeImports(text);
  const routes: RawRoute[] = [];
  const mounts: RawMount[] = [];

  const CALL = new RegExp(`(?<![\\w$.])(${names})\\s*\\.\\s*(${VERBS.join("|")}|route|use)\\s*\\(`, "g");
  for (const m of skeleton.matchAll(CALL)) {
    const receiver = m[1] as string;
    const method = m[2] as string;
    const open = (m.index as number) + m[0].length - 1;
    const call = readArgs(text, open);
    if (!call) continue;
    const first = call.args[0];
    const path = first ? stringLiteral(first.raw) : undefined;
    const line = lineOf(m.index as number);

    if (VERB_SET.has(method)) {
      // `app.get("setting")` with one argument is Express's settings getter.
      if (path === undefined || !isRoutePath(path) || call.args.length < 2) continue;
      routes.push({ receiver, method: method.toUpperCase(), path, line, end: lineOf(call.end - 1), handler: lastHandler(call.args.slice(1)) });
      continue;
    }

    if (method === "route") {
      if (path === undefined || !isRoutePath(path)) continue;
      // Walk the chain: .route("/x").get(h).post(h)…
      let at = call.end;
      for (;;) {
        const chain = /^\s*\.\s*([a-z]+)\s*\(/.exec(skeleton.slice(at, at + 200));
        if (!chain || !VERB_SET.has(chain[1] as string)) break;
        const open2 = at + chain[0].length - 1;
        const inner = readArgs(text, open2);
        if (!inner) break;
        const dot = skeleton.indexOf(".", at);
        routes.push({
          receiver,
          method: (chain[1] as string).toUpperCase(),
          path,
          line: lineOf(dot),
          end: lineOf(inner.end - 1),
          handler: lastHandler(inner.args),
        });
        at = inner.end;
      }
      continue;
    }

    // use(prefix, …mounted)
    if (path === undefined || !path.startsWith("/")) continue;
    for (const arg of call.args.slice(1)) {
      const raw = arg.raw;
      if (receivers.has(raw) && raw !== receiver) {
        mounts.push({ parent: receiver, prefix: path, line, local: raw });
        continue;
      }
      const req = /^require\s*\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)(?:\s*\.\s*[\w$]+)?$/.exec(raw);
      const spec = req ? req[2] : /^[A-Za-z_$][\w$]*$/.test(raw) ? imports.get(raw) : undefined;
      const target = spec ? resolveRelative(input.rel, spec) : undefined;
      if (target) mounts.push({ parent: receiver, prefix: path, line, target });
    }
  }

  // Same-file mounts: a router mounted on the app in this file gets its prefix here.
  const localParents = new Map<string, RawMount[]>();
  for (const mt of mounts) {
    if (!mt.local) continue;
    const list = localParents.get(mt.local) ?? [];
    list.push(mt);
    localParents.set(mt.local, list);
  }
  const prefixesOf = (recv: string, seen: Set<string>): string[] => {
    const parents = localParents.get(recv);
    if (!parents || seen.has(recv)) return [""];
    const next = new Set(seen).add(recv);
    return parents.flatMap((p) => prefixesOf(p.parent, next).map((outer) => joinRoutePath(outer, p.prefix)));
  };

  const facts: RouteFact[] = [];
  for (const r of routes) {
    for (const prefix of prefixesOf(r.receiver, new Set())) {
      const fact: RouteFact = { method: r.method, path: joinRoutePath(prefix, r.path), file: input.rel, line: r.line, end: r.end, framework: FRAMEWORK };
      if (r.handler) fact.handler = r.handler;
      facts.push(fact);
    }
  }
  const hints: MountHint[] = [];
  for (const mt of mounts) {
    if (!mt.target) continue;
    for (const outer of prefixesOf(mt.parent, new Set())) {
      hints.push({ kind: "mount", framework: FRAMEWORK, file: input.rel, line: mt.line, prefix: joinRoutePath(outer, mt.prefix), target: mt.target });
    }
  }
  const out: ExtractOutput = {};
  if (facts.length) out.routes = facts;
  if (hints.length) out.hints = hints;
  return out;
}

export const expressExtractor: Extractor = {
  id: "express",
  applies(input: ExtractInput, ctx: RepoContext): boolean {
    return isJsLike(input.rel) && ctx.depsFor(input.rel).has("express");
  },
  extract: extractExpress,
};

/**
 * Cross-file mounts: `app.use("/api", ordersRouter)` in src/server.ts, with
 * `ordersRouter` imported from ./routes/orders, prefixes every Express route
 * of src/routes/orders.ts with `/api`. Nested mounts compose; a file mounted
 * twice yields its routes under both prefixes; cycles are cut.
 */
export const expressMountLinker: Linker = {
  id: "express-mounts",
  link(facts: Facts, ctx) {
    const files = new Set(ctx.files);
    return applyMounts(facts, ctx.hints, FRAMEWORK, (h) => moduleFile(h.target, files));
  },
};
