// URL normalisation shared by every call extractor (JS fetch / axios / ky /
// ofetch, Python requests / httpx), so a call reads the same whatever
// language made it and the `http-calls` linker can match it to any route.
//
// Each language parses its own URL expressions (template literals,
// f-strings, concatenation) into one TEMPLATE: the URL's text with a HOLE
// (`URL_HOLE`) for every non-literal part. From there, one set of rules
// (docs/design.md §5):
//   - a leading HOLE is a base (`${process.env.API_URL}/users`,
//     `f"{settings.API}/users"`) and is dropped;
//   - query and fragment are dropped;
//   - scheme + host are dropped for localhost and for hosts built from
//     expressions; other hosts stay (someone else's API), lower-cased;
//   - a path segment holding a HOLE becomes `:p`; empty segments and the
//     trailing slash go.

import { cleanRoutePath } from "./routing.js";

/** Placeholder for a non-literal part of a URL template: a private-use character, never in a URL. */
export const URL_HOLE = "";

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** An absolute URL with a scheme (`https://…`), as opposed to a path. */
export function isAbsoluteUrl(url: string): boolean {
  return ABSOLUTE.test(url);
}

function normalizeSegments(path: string): string {
  const leading = path.startsWith("/");
  const segs = path
    .split("/")
    .filter((s) => s !== "")
    .map((s) => (s.includes(URL_HOLE) ? ":p" : s));
  const joined = segs.join("/");
  return leading ? cleanRoutePath(joined) : joined;
}

/**
 * Normalize a URL template to `/path/:p`, `https://host/path` (another host),
 * or `relative/path` (meaningful only under a base). Undefined when nothing
 * is left to tell a path by.
 */
export function normalizeUrlTemplate(template: string): string | undefined {
  let s = template;
  const cut = s.search(/[?#]/);
  if (cut !== -1) s = s.slice(0, cut);
  if (s.startsWith(URL_HOLE)) {
    while (s.startsWith(URL_HOLE)) s = s.slice(URL_HOLE.length);
    if (!s) return undefined;
    // `${proto}://${host}/api`: the scheme was the expression, the host follows.
    s = s.replace(/^:?\/\/[^/]*/, "");
    if (ABSOLUTE.test(s)) return undefined;
    return normalizeSegments(`/${s}`);
  }
  const abs = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/]*)(.*)$/i.exec(s);
  if (abs) {
    const host = abs[2] as string;
    const rest = abs[3] || "/";
    const path = normalizeSegments(rest.startsWith("/") ? rest : `/${rest}`);
    if (!host || host.includes(URL_HOLE) || LOCAL_HOST.test(host)) return path;
    return `${(abs[1] as string).toLowerCase()}${host.toLowerCase()}${path === "/" ? "" : path}`;
  }
  if (s.startsWith("/")) return normalizeSegments(s);
  return normalizeSegments(s) || undefined;
}

/**
 * A client's base URL from its template: undefined when there is none, ""
 * when it is not a literal (an env / config value: dropped) or names this app
 * (localhost), else the normalized literal.
 */
export function normalizeBaseUrl(template: string | undefined): string | undefined {
  if (template === undefined) return undefined;
  const url = normalizeUrlTemplate(template);
  return url === undefined || url === "/" ? "" : url;
}

/**
 * Join a client base and a call URL the way axios / ky / ofetch / httpx do.
 * `base` undefined: no client base, so a relative URL means nothing
 * (undefined); "" (a dropped base): the URL is a path of the app; a literal:
 * prefixed. An absolute call URL ignores the base.
 */
export function joinBaseUrl(base: string | undefined, url: string): string | undefined {
  if (ABSOLUTE.test(url)) return url;
  if (base === undefined) return url.startsWith("/") ? url : undefined;
  const tail = url.replace(/^\/+/, "");
  if (ABSOLUTE.test(base)) return tail ? `${base.replace(/\/+$/, "")}/${tail}` : base;
  return cleanRoutePath(`${base}/${tail}`);
}
