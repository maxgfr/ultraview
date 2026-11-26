// File-system routers: the route or screen is the file's path, the HTTP
// methods are what the file exports. Every router is keyed on the file's path
// relative to its workspace and gated on the workspace declaring the
// framework, so an `app/page.tsx` in a non-Next package is nothing.
//
//   next-app     app/**/route.ts → exported GET/POST/…; app/**/page.tsx → screen
//                (also under src/); `(group)` and `@slot` folders dropped,
//                `_private` folders and `(.)intercepting` routes skipped.
//   next-pages   pages/api/** → route (methods from `req.method` checks, else
//                ALL); other pages/** → screen (`_app`, `_document`, `_error`
//                excluded).
//   nuxt         server/api/** → /api/…, server/routes/** → /…, method from a
//                `.get.ts` suffix (else ALL); pages/**.vue → screen.
//   sveltekit    src/routes/**/+server.ts → exported handlers (`fallback` = ALL);
//                +page.svelte → screen.
//   remix        app/routes/* flat routes (Remix v2, React Router v7
//                fs-routes): `loader` → GET, `action` → POST, default export →
//                screen.

import { lastLine } from "./extent.js";
import { isJsLike } from "./js.js";
import { extOf, lineIndex } from "./mask.js";
import { bracketSegment, flatRoutePath, pathFromSegments } from "./routing.js";
import { declares, defaultExportName, defaultExportOffset, exportedNames, sourceViews, workspaceRelative } from "./source.js";
import type { ExtractInput, ExtractOutput, Extractor, RepoContext, RouteFact, ScreenFact } from "./types.js";

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The part of `sub` under the first matching root, or undefined. */
function under(sub: string, roots: readonly string[]): string | undefined {
  for (const r of roots) if (sub.startsWith(r)) return sub.slice(r.length);
  return undefined;
}

function lineAt(text: string, offset: number | undefined): number {
  return offset === undefined ? 1 : lineIndex(text)(offset);
}

/** Where a default export starts (its extent is the statement there); with none, the whole file is the fact. */
function defaultAt(text: string, offset: number | undefined): { line: number; end?: number } {
  return offset === undefined ? { line: 1, end: lastLine(text) } : { line: lineAt(text, offset) };
}

/** Exported HTTP handlers (`export async function GET`, `export { h as POST }`, `export const { GET } = …`). */
function exportedHandlers(input: ExtractInput, file: string, path: string, framework: string, map: (name: string) => string | undefined): RouteFact[] {
  const { skeleton, lineOf } = sourceViews(input);
  const out: RouteFact[] = [];
  for (const e of exportedNames(skeleton)) {
    const method = map(e.name);
    if (!method) continue;
    out.push({ method, path, file, line: lineOf(e.offset), framework, handler: e.local });
  }
  return out;
}

// --- Next.js app router -------------------------------------------------------

const NEXT_APP_ROOTS = ["app/", "src/app/"];

function nextAppParts(input: ExtractInput, ctx: RepoContext): { dirs: string[]; base: string } | undefined {
  if (!isJsLike(input.rel) && extOf(input.rel) !== ".mdx") return undefined;
  const rest = under(workspaceRelative(ctx, input.rel).sub, NEXT_APP_ROOTS);
  if (rest === undefined) return undefined;
  const parts = rest.split("/");
  const base = stem(parts.pop() as string);
  if (base !== "route" && base !== "page") return undefined;
  if (parts.some((d) => d.startsWith("_") || /^\(\.{1,3}\)/.test(d))) return undefined;
  return { dirs: parts, base };
}

export const nextAppExtractor: Extractor = {
  id: "next-app",
  applies(input, ctx) {
    return declares(ctx, input.rel, ["next"]) && nextAppParts(input, ctx) !== undefined;
  },
  extract(input, ctx): ExtractOutput {
    const parts = nextAppParts(input, ctx);
    if (!parts) return {};
    const path = pathFromSegments(parts.dirs.map(bracketSegment));
    if (parts.base === "route") {
      const routes = exportedHandlers(input, input.rel, path, "next-app", (n) => (HTTP_METHODS.has(n) ? n : undefined));
      return routes.length ? { routes } : {};
    }
    const { skeleton } = sourceViews(input);
    return { screens: [{ path, file: input.rel, ...defaultAt(skeleton, defaultExportOffset(skeleton)), framework: "next-app" }] };
  },
};

// --- Next.js pages router -----------------------------------------------------

const NEXT_PAGES_ROOTS = ["pages/", "src/pages/"];
const NEXT_SPECIAL_PAGES = new Set(["_app", "_document", "_error"]);

function nextPagesParts(input: ExtractInput, ctx: RepoContext): string[] | undefined {
  if (!isJsLike(input.rel)) return undefined;
  const rest = under(workspaceRelative(ctx, input.rel).sub, NEXT_PAGES_ROOTS);
  if (rest === undefined) return undefined;
  const parts = rest.split("/");
  const last = stem(parts.pop() as string);
  if (parts.length === 0 && NEXT_SPECIAL_PAGES.has(last)) return undefined;
  if (last !== "index") parts.push(last);
  return parts;
}

/** Methods a pages-API handler checks for: `req.method === "POST"`, `!==`, `switch (req.method) { case "GET": … }`, `["GET"].includes(req.method)`. */
function checkedMethods(text: string, skeleton: string): string[] {
  const found = new Set<string>();
  const take = (raw: string) => {
    const v = raw.toUpperCase();
    if (HTTP_METHODS.has(v)) found.add(v);
  };
  const literalAt = (quote: number): string | undefined => {
    const q = text[quote];
    const close = text.indexOf(q as string, quote + 1);
    return close === -1 ? undefined : text.slice(quote + 1, close);
  };
  for (const m of skeleton.matchAll(/\.\s*method\s*(?:===?|!==?)\s*(["'])/g)) {
    const v = literalAt((m.index as number) + m[0].length - 1);
    if (v) take(v);
  }
  for (const m of skeleton.matchAll(/(["'])\s*(?:===?|!==?)\s*[\w$]+\s*\.\s*method\b/g)) {
    const end = m.index as number;
    const open = text.lastIndexOf(m[1] as string, end - 1);
    if (open !== -1) take(text.slice(open + 1, end));
  }
  for (const m of skeleton.matchAll(/\]\s*\.\s*includes\s*\(\s*[\w$]+\s*\.\s*method\s*\)/g)) {
    const close = m.index as number;
    const open = skeleton.lastIndexOf("[", close);
    for (const lit of text.slice(open + 1, close).matchAll(/["']([A-Za-z]+)["']/g)) take(lit[1] as string);
  }
  for (const m of skeleton.matchAll(/\bswitch\s*\(\s*[\w$]+\s*\.\s*method\s*(?:\.\s*toUpperCase\s*\(\s*\)\s*)?\)\s*\{/g)) {
    const open = (m.index as number) + m[0].length - 1;
    let depth = 0;
    let end = skeleton.length;
    for (let i = open; i < skeleton.length; i++) {
      if (skeleton[i] === "{") depth++;
      else if (skeleton[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    for (const c of skeleton.slice(open, end).matchAll(/\bcase\s*(["'])/g)) {
      const v = literalAt(open + (c.index as number) + c[0].length - 1);
      if (v) take(v);
    }
  }
  return [...found].sort();
}

export const nextPagesExtractor: Extractor = {
  id: "next-pages",
  applies(input, ctx) {
    return declares(ctx, input.rel, ["next"]) && nextPagesParts(input, ctx) !== undefined;
  },
  extract(input, ctx): ExtractOutput {
    const parts = nextPagesParts(input, ctx);
    if (!parts) return {};
    const { text, skeleton } = sourceViews(input);
    const path = pathFromSegments(parts.map(bracketSegment));
    const at = defaultAt(skeleton, defaultExportOffset(skeleton));
    if (parts[0] === "api") {
      const handler = defaultExportName(skeleton);
      const methods = checkedMethods(text, skeleton);
      const routes = (methods.length ? methods : ["ALL"]).map((method) => {
        const r: RouteFact = { method, path, file: input.rel, ...at, framework: "next-pages" };
        if (handler) r.handler = handler;
        return r;
      });
      return { routes };
    }
    return { screens: [{ path, file: input.rel, ...at, framework: "next-pages" }] };
  },
};

// --- Nuxt ---------------------------------------------------------------------

const NUXT_DEPS = ["nuxt", "nuxt3", "nitropack", "nitro"];
const NUXT_SERVER_ROOTS: readonly [string, string][] = [
  ["server/api/", "api"],
  ["server/routes/", ""],
];
const NUXT_PAGE_ROOTS = ["pages/", "app/pages/", "src/pages/"];
const NUXT_PAGE_EXT = new Set([".vue", ".tsx", ".jsx"]);
const NITRO_METHOD = /\.(get|head|post|put|delete|patch|options|connect|trace)$/;

function nuxtServerRoute(input: ExtractInput, ctx: RepoContext): { method: string; path: string } | undefined {
  if (!isJsLike(input.rel)) return undefined;
  const { sub } = workspaceRelative(ctx, input.rel);
  for (const [root, prefix] of NUXT_SERVER_ROOTS) {
    if (!sub.startsWith(root)) continue;
    const parts = sub.slice(root.length).split("/");
    let last = stem(parts.pop() as string);
    let method = "ALL";
    const m = NITRO_METHOD.exec(last);
    if (m) {
      method = (m[1] as string).toUpperCase();
      last = last.slice(0, m.index);
    }
    if (last !== "index") parts.push(last);
    return { method, path: pathFromSegments([prefix, ...parts.map(bracketSegment)]) };
  }
  return undefined;
}

export const nuxtServerExtractor: Extractor = {
  id: "nuxt-server",
  applies(input, ctx) {
    return declares(ctx, input.rel, NUXT_DEPS) && nuxtServerRoute(input, ctx) !== undefined;
  },
  extract(input, ctx): ExtractOutput {
    const route = nuxtServerRoute(input, ctx);
    if (!route) return {};
    const { skeleton } = sourceViews(input);
    return { routes: [{ ...route, file: input.rel, ...defaultAt(skeleton, defaultExportOffset(skeleton)), framework: "nuxt" }] };
  },
};

function nuxtPagePath(input: ExtractInput, ctx: RepoContext): string | undefined {
  if (!NUXT_PAGE_EXT.has(extOf(input.rel))) return undefined;
  const rest = under(workspaceRelative(ctx, input.rel).sub, NUXT_PAGE_ROOTS);
  if (rest === undefined) return undefined;
  const parts = rest.split("/");
  const last = stem(parts.pop() as string);
  if (last !== "index") parts.push(last);
  return pathFromSegments(parts.map(bracketSegment));
}

export const nuxtPagesExtractor: Extractor = {
  id: "nuxt-pages",
  applies(input, ctx) {
    return declares(ctx, input.rel, ["nuxt", "nuxt3"]) && nuxtPagePath(input, ctx) !== undefined;
  },
  extract(input, ctx): ExtractOutput {
    const path = nuxtPagePath(input, ctx);
    return path === undefined ? {} : { screens: [{ path, file: input.rel, line: 1, end: lastLine(input.text), framework: "nuxt" }] };
  },
};

// --- SvelteKit ----------------------------------------------------------------

const SVELTEKIT_METHODS = new Map([...[...HTTP_METHODS].map((m) => [m, m] as const), ["fallback", "ALL"]]);

function svelteKitParts(input: ExtractInput, ctx: RepoContext): { dirs: string[]; base: string } | undefined {
  const rest = under(workspaceRelative(ctx, input.rel).sub, ["src/routes/"]);
  if (rest === undefined) return undefined;
  const parts = rest.split("/");
  const base = parts.pop() as string;
  if (base === "+page.svelte" || /^\+server\.[cm]?[jt]s$/.test(base)) return { dirs: parts, base };
  return undefined;
}

export const svelteKitExtractor: Extractor = {
  id: "sveltekit",
  applies(input, ctx) {
    return declares(ctx, input.rel, ["@sveltejs/kit"]) && svelteKitParts(input, ctx) !== undefined;
  },
  extract(input, ctx): ExtractOutput {
    const parts = svelteKitParts(input, ctx);
    if (!parts) return {};
    const path = pathFromSegments(parts.dirs.map(bracketSegment));
    if (parts.base === "+page.svelte") return { screens: [{ path, file: input.rel, line: 1, end: lastLine(input.text), framework: "sveltekit" }] };
    const routes = exportedHandlers(input, input.rel, path, "sveltekit", (n) => SVELTEKIT_METHODS.get(n));
    return routes.length ? { routes } : {};
  },
};

// --- Remix / React Router v7 flat routes -------------------------------------

const REMIX_DEPS = ["@remix-run/", "@react-router/fs-routes"];

/** The flat-route name of a route module: `app/routes/users.$id.tsx` or `app/routes/users.$id/route.tsx`. */
function remixRouteName(input: ExtractInput, ctx: RepoContext): string | undefined {
  if (!isJsLike(input.rel)) return undefined;
  const rest = under(workspaceRelative(ctx, input.rel).sub, ["app/routes/"]);
  if (rest === undefined) return undefined;
  const parts = rest.split("/");
  if (parts.length === 1) return stem(parts[0] as string);
  if (parts.length === 2 && stem(parts[1] as string) === "route") return parts[0];
  return undefined;
}

export const remixExtractor: Extractor = {
  id: "remix",
  applies(input, ctx) {
    return declares(ctx, input.rel, REMIX_DEPS) && remixRouteName(input, ctx) !== undefined;
  },
  extract(input, ctx): ExtractOutput {
    const name = remixRouteName(input, ctx);
    if (name === undefined) return {};
    const path = flatRoutePath(name);
    const routes = exportedHandlers(input, input.rel, path, "remix", (n) => (n === "loader" ? "GET" : n === "action" ? "POST" : undefined));
    const out: ExtractOutput = {};
    if (routes.length) out.routes = routes;
    const { skeleton } = sourceViews(input);
    const def = defaultExportOffset(skeleton);
    if (def !== undefined) out.screens = [{ path, file: input.rel, line: lineAt(skeleton, def), framework: "remix" } satisfies ScreenFact];
    return out;
  },
};
