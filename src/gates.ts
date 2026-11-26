// The gates a saved answer passes (docs/design.md §7), shared by `check`
// (lenses, conversation turns) and `lens save --thread` (src/chat.ts), so a
// turn is refused at save time by the very rules `check` applies later; and
// the one repair made before them (repairAnswerIds), shared by `lens save`,
// `lens save --thread` and the Ask bridge.

import { checkCitations, type fileLineTable } from "./engine.js";
import { isNodeId } from "./model/ids.js";
import { uncitedSentences } from "./model/prose.js";
import { NODE_KINDS } from "./model/types.js";
import type { Problem } from "./model/validate.js";

type LineTable = ReturnType<typeof fileLineTable>;

export const unknownNode = (id: string) => `unknown node "${id}" (run \`ultraview show <id>\` on a known one, or see the build summary)`;

/** Cited prose: every citation resolves (with a line table), every sentence cites. */
export function proseProblems(path: string, text: string | undefined, lineTable?: LineTable): Problem[] {
  if (text === undefined) return [];
  const out: Problem[] = [];
  if (lineTable) for (const u of checkCitations(text, lineTable).unresolved) out.push({ path, message: `dead citation [${u.citation.raw}]: ${u.reason}` });
  for (const s of uncitedSentences(text)) out.push({ path, message: `uncited sentence: "${s.length > 120 ? `${s.slice(0, 117)}...` : s}"` });
  return out;
}

/**
 * The gates a saved answer passes beyond \`lens save\` (a lens, or a
 * conversation turn's answer): its node ids resolve to nodes of the map, its
 * prose cites every sentence, and, given the index's line table, every
 * citation resolves. Paths are relative to \`prefix\` (\`turns[2].answer.\`).
 */
export function answerProblems(
  a: { answer: string; nodes: string[]; edges?: { from: string; to: string }[]; focus?: string },
  ids: ReadonlySet<string>,
  lineTable?: LineTable,
  prefix = "",
): Problem[] {
  const out: Problem[] = [];
  const resolveId = (path: string, id: string | undefined) => {
    if (id !== undefined && !ids.has(id)) out.push({ path: `${prefix}${path}`, message: unknownNode(id) });
  };
  a.nodes.forEach((n, i) => resolveId(`nodes[${i}]`, n));
  (a.edges ?? []).forEach((e, i) => {
    resolveId(`edges[${i}].from`, e.from);
    resolveId(`edges[${i}].to`, e.to);
  });
  resolveId("focus", a.focus);
  out.push(...proseProblems(`${prefix}answer`, a.answer, lineTable));
  return out;
}

/** One node id rewritten before the gates: where it was, what was written, what it became. */
export interface IdRepair {
  path: string;
  from: string;
  to: string;
}

/**
 * The node id of the view that `value` stands for, when exactly one fits:
 * `<kind>:<value>` for some node kind (`src-diff` → `mod:src-diff`,
 * `Order` → `entity:Order`), or `file:<value>` for a repo-relative path, a
 * leading `./` dropped (`./src/x.ts` → `file:src/x.ts`). Undefined when
 * `value` is already a node id of the view, when none fits, or when several
 * do: no other guess is made.
 */
export function repairNodeId(value: string, ids: ReadonlySet<string>): string | undefined {
  if (ids.has(value)) return undefined;
  const fits = new Set<string>();
  for (const kind of NODE_KINDS) if (ids.has(`${kind}:${value}`)) fits.add(`${kind}:${value}`);
  const path = value.startsWith("./") ? value.slice(2) : value;
  if (path && ids.has(`file:${path}`)) fits.add(`file:${path}`);
  return fits.size === 1 ? [...fits][0] : undefined;
}

/**
 * An answer (a lens, a turn) with the node ids it names (`nodes`, each edge's
 * `from` / `to`, `focus`) repaired by `repairNodeId`, and the list of what was
 * rewritten. Only a value that is not a well-formed node id is looked at (a
 * well-formed one that names no node fails the gates as it is), so `ids` (the
 * view's node ids) is read only when one is there. Anything that is not the
 * expected shape is left to the schema; the input is never mutated.
 */
export function repairAnswerIds<T>(value: T, ids: () => ReadonlySet<string>): { value: T; repairs: IdRepair[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, repairs: [] };
  const rec = value as Record<string, unknown>;
  const loose = (v: unknown): v is string => typeof v === "string" && !isNodeId(v);
  const edges = Array.isArray(rec.edges) ? rec.edges : [];
  const isEdge = (e: unknown): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e);
  const any = (Array.isArray(rec.nodes) && rec.nodes.some(loose)) || edges.some((e) => isEdge(e) && (loose(e.from) || loose(e.to))) || loose(rec.focus);
  if (!any) return { value, repairs: [] };

  const known = ids();
  const repairs: IdRepair[] = [];
  const fix = (path: string, v: unknown): unknown => {
    if (!loose(v)) return v;
    const to = repairNodeId(v, known);
    if (to === undefined) return v;
    repairs.push({ path, from: v, to });
    return to;
  };
  const out: Record<string, unknown> = { ...rec };
  if (Array.isArray(rec.nodes)) out.nodes = rec.nodes.map((n, i) => fix(`nodes[${i}]`, n));
  if (Array.isArray(rec.edges))
    out.edges = rec.edges.map((e, i) => {
      if (!isEdge(e)) return e;
      const edge = { ...e };
      for (const end of ["from", "to"] as const) if (end in e) edge[end] = fix(`edges[${i}].${end}`, e[end]);
      return edge;
    });
  if ("focus" in rec) out.focus = fix("focus", rec.focus);
  return repairs.length ? { value: out as T, repairs } : { value, repairs: [] };
}

/** The lines saying what was repaired (`  nodes[0]: "src-diff" -> "mod:src-diff"`). */
export const repairLines = (repairs: readonly IdRepair[], indent = "  "): string[] =>
  repairs.map((r) => `${indent}${r.path}: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`);
