// Path-prefix mounts shared by every routing framework: one file's routes
// served under a prefix declared in another file.
//
//   Express   app.use("/api", ordersRouter)
//   FastAPI   app.include_router(orders.router, prefix="/api")
//   Flask     app.register_blueprint(orders_bp, url_prefix="/api")
//   Django    path("api/", include("orders.urls"))
//
// The extractor that sees the mount leaves a `MountHint` (prefix + target
// module); a framework's linker resolves the target to a file and calls
// `applyMounts`, which prefixes every route of that framework in the target
// file. Nested mounts compose, a file mounted twice serves its routes under
// both prefixes, and cycles are cut.

import type { Facts, LinkHint, MountHint, RouteFact } from "./types.js";

/** Join a mount prefix and a route path the way routers compose them (`/api` + `/x` → `/api/x`). */
export function joinRoutePath(prefix: string, path: string): string {
  if (!prefix || prefix === "/") return path || "/";
  const p = path === "/" || path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
  const joined = `${prefix.replace(/\/+$/, "")}${p}`.replace(/\/{2,}/g, "/");
  return joined || "/";
}

/**
 * Prefix the `framework` routes of every mounted file. `resolve` maps a hint's
 * target to the indexed file it names (undefined when it names none).
 */
export function applyMounts(facts: Facts, hints: readonly LinkHint[], framework: string, resolve: (hint: MountHint) => string | undefined): Facts {
  const parents = new Map<string, { file: string; prefix: string }[]>();
  for (const h of hints) {
    if (h.kind !== "mount" || h.framework !== framework) continue;
    const child = resolve(h);
    if (!child || child === h.file) continue;
    const list = parents.get(child) ?? [];
    list.push({ file: h.file, prefix: h.prefix });
    parents.set(child, list);
  }
  if (!parents.size) return facts;
  const prefixesOf = (file: string, seen: Set<string>): string[] => {
    const list = parents.get(file);
    if (!list || seen.has(file)) return [""];
    const next = new Set(seen).add(file);
    const out = new Set<string>();
    for (const p of list) for (const outer of prefixesOf(p.file, next)) out.add(joinRoutePath(outer, p.prefix));
    return [...out];
  };
  const routes: RouteFact[] = [];
  for (const r of facts.routes) {
    if (r.framework !== framework || !parents.has(r.file)) {
      routes.push(r);
      continue;
    }
    for (const prefix of prefixesOf(r.file, new Set())) routes.push({ ...r, path: joinRoutePath(prefix, r.path) });
  }
  return { ...facts, routes };
}
