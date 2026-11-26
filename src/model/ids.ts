// Node identity (docs/design.md §2): every node has a namespaced id, stable
// across runs, whose prefix is its kind. The single source of truth for
// building and reading ids — the CLI, the check gate and the viewer all go
// through here. Framework-free and side-effect-free.

import { NODE_KINDS, type NodeKind } from "./types.js";

/** Slug shape of the ids the agent writes (systems, capabilities, flows, lenses). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Derived capability holding every non-test module no capability claims. */
export const FOUNDATIONS_CAP = "cap:_foundations";
export const FOUNDATIONS_LABEL = "Shared foundations";
/** Derived system holding every file no system's globs match. */
export const UNASSIGNED_SYS = "sys:_unassigned";
export const UNASSIGNED_LABEL = "Unassigned";
/** The single system of a repo with neither a model nor workspaces. */
export const APP_SYS = "sys:app";

export const capId = (slug: string) => `cap:${slug}`;
export const sysId = (slug: string) => `sys:${slug}`;
export const modId = (slug: string) => `mod:${slug}`;
export const fileId = (rel: string) => `file:${rel}`;
export const symId = (rel: string, name: string) => `sym:${rel}#${name}`;
export const routeId = (method: string, path: string) => `route:${method.toUpperCase()} ${path}`;
export const screenId = (path: string) => `screen:${path}`;
export const entityId = (name: string) => `entity:${name}`;
export const jobId = (id: string) => `job:${id}`;
export const extId = (id: string) => `ext:${id}`;
export const infraId = (id: string) => `infra:${id}`;

export type ParsedId =
  | { kind: "cap" | "sys" | "mod" | "entity" | "job" | "ext" | "infra"; name: string }
  | { kind: "file"; path: string }
  | { kind: "sym"; path: string; name: string }
  | { kind: "route"; method: string; path: string }
  | { kind: "screen"; path: string };

/** The kind of a node id (its prefix), or undefined when the prefix is not a node kind. */
export function kindOf(id: string): NodeKind | undefined {
  const colon = id.indexOf(":");
  if (colon <= 0) return undefined;
  const prefix = id.slice(0, colon);
  return (NODE_KINDS as readonly string[]).includes(prefix) ? (prefix as NodeKind) : undefined;
}

/** Parse a node id into its parts; undefined when it is not a well-formed id. */
export function parseId(id: string): ParsedId | undefined {
  const kind = kindOf(id);
  if (!kind) return undefined;
  const rest = id.slice(kind.length + 1);
  if (!rest) return undefined;
  switch (kind) {
    case "file":
      return { kind, path: rest };
    case "screen":
      return { kind, path: rest };
    case "sym": {
      const hash = rest.lastIndexOf("#");
      if (hash <= 0 || hash === rest.length - 1) return undefined;
      return { kind, path: rest.slice(0, hash), name: rest.slice(hash + 1) };
    }
    case "route": {
      const space = rest.indexOf(" ");
      if (space <= 0 || space === rest.length - 1) return undefined;
      const method = rest.slice(0, space);
      if (method !== method.toUpperCase()) return undefined;
      return { kind, method, path: rest.slice(space + 1) };
    }
    default:
      return { kind, name: rest };
  }
}

/** Rebuild the id of parsed parts: `formatId(parseId(id)!) === id` for every well-formed id. */
export function formatId(p: ParsedId): string {
  switch (p.kind) {
    case "file":
      return fileId(p.path);
    case "screen":
      return screenId(p.path);
    case "sym":
      return symId(p.path, p.name);
    case "route":
      return routeId(p.method, p.path);
    default:
      return `${p.kind}:${p.name}`;
  }
}

export const isNodeId = (id: string): boolean => parseId(id) !== undefined;

/** The repo-relative file a file / symbol id names, if any. */
export function fileOfId(id: string): string | undefined {
  const p = parseId(id);
  return p && (p.kind === "file" || p.kind === "sym") ? p.path : undefined;
}
