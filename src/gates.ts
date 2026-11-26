// The gates a saved answer passes (docs/design.md §7), shared by `check`
// (lenses, conversation turns) and `lens save --thread` (src/chat.ts), so a
// turn is refused at save time by the very rules `check` applies later.

import { checkCitations, type fileLineTable } from "./engine.js";
import { uncitedSentences } from "./model/prose.js";
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
