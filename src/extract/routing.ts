// Route paths shared by the JS/TS web extractors: file-system routing
// segments (Next.js, Nuxt, SvelteKit, Remix flat routes), path cleanup, and
// the pattern match the `http-calls` linker uses.
//
// Path vocabulary, every framework mapped onto it: a literal segment, a
// parameter `:name` (one segment), a catch-all `*name` or `*` (the rest).

/** Leading slash, no doubled or trailing slash (`/` for the root). */
export function cleanRoutePath(path: string): string {
  let p = path.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** A path from segments, empty ones dropped. */
export function pathFromSegments(segments: readonly string[]): string {
  return cleanRoutePath(segments.filter((s) => s !== "").join("/"));
}

/**
 * One folder or file name of a bracket-style file router (Next.js, Nuxt,
 * SvelteKit) as a path segment. Route groups `(x)` and parallel-route slots
 * `@x` contribute nothing (""). `[id]` → `:id`, `[[id]]` → `:id` (optional),
 * `[...slug]` / `[[...slug]]` → `*slug`, SvelteKit matchers `[id=int]` → `:id`.
 */
export function bracketSegment(segment: string): string {
  if (/^\(.*\)$/.test(segment) || segment.startsWith("@")) return "";
  const rest = /^\[\[?\.\.\.([^\]=]+)(?:=[^\]]*)?\]\]?$/.exec(segment);
  if (rest) return `*${rest[1]}`;
  return segment.replace(/\[\[?([^\]=]+)(?:=[^\]]*)?\]\]?/g, (_m, name: string) => `:${name}`);
}

/** Split a Remix flat-route name on `.`, keeping `[.]`-escaped dots inside their segment. */
function splitFlat(name: string): string[] {
  const out: string[] = [];
  let cur = "";
  let escaped = false;
  for (const ch of name) {
    if (ch === "[") escaped = true;
    else if (ch === "]") escaped = false;
    if (ch === "." && !escaped) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * A Remix / React Router flat-route module name (`users.$id_.edit`, `_auth.login`,
 * `_index`, `($lang).docs.$`) as a path. `_index` and pathless `_layout`
 * segments contribute nothing, a trailing `_` (layout opt-out) is dropped,
 * `$id` → `:id`, `$` → `*`, `($lang)` → `:lang`, `(opt)` → `opt`, `[x]` escapes.
 */
export function flatRoutePath(name: string): string {
  const segments = splitFlat(name).map((raw) => {
    if (raw === "_index" || raw === "index") return "";
    if (raw.startsWith("_")) return "";
    let seg = raw.endsWith("_") ? raw.slice(0, -1) : raw;
    const optional = /^\((.*)\)$/.exec(seg);
    if (optional) seg = optional[1] as string;
    if (seg === "$") return "*";
    if (seg.startsWith("$")) return `:${seg.slice(1)}`;
    return seg.replace(/\[([^\]]*)\]/g, "$1");
  });
  return pathFromSegments(segments);
}

/** Strip inline pattern constraints: Hono `:id{[0-9]+}`, Vue / path-to-regexp `:id(\\d+)`; `:x(.*)*` → `*x`. */
export function stripParamPatterns(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      const catchAll = /^:([\w$]+)\(\.\*\)[*+]?$/.exec(seg);
      if (catchAll) return `*${catchAll[1]}`;
      return seg.replace(/^(:[\w$]+)(?:\{[^}]*\}|\([^)]*\))([?*+]?)$/, "$1$2");
    })
    .join("/");
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/**
 * How a call URL (template parameters as `:p`) matches a route path: undefined
 * when it does not, else a specificity key — `[catch-alls, params]`, lower is
 * more specific. A route `:id` matches any one segment, `*slug` (or `*`) the
 * rest of the path, zero segments included. A call `:p` is unknown at
 * analysis time, so it only matches a route parameter or catch-all, never a
 * literal segment (`/users/${id}` is not a call to `/users/me`).
 */
export function routeMatchKey(url: string, path: string): [number, number] | undefined {
  const u = segmentsOf(url);
  const r = segmentsOf(path);
  let params = 0;
  for (let i = 0; i < r.length; i++) {
    const rs = r[i] as string;
    if (rs.startsWith("*")) return [1, params];
    const us = u[i];
    if (us === undefined) return undefined;
    if (rs.startsWith(":")) {
      params++;
      continue;
    }
    if (us === ":p" || us !== rs) return undefined;
  }
  return u.length === r.length ? [0, params] : undefined;
}
