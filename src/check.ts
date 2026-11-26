// `ultraview check`, as a library call (docs/design.md §7): the gate the agent
// runs until clean after writing model.json, flows or lenses.
//
//   errors    schema problems; node ids that resolve to nothing; dead citations
//             (ultraindex `checkCitations` against the index's line table);
//             sentences without a citation (timeline `auto` summaries
//             aside); coverage below the thresholds;
//             a stale index or missing facts (re-run `build` first)
//   conversations: every turn of `.ultraview/conversations/<id>.json` passes a
//             lens's gates (src/gates.ts) and the file its schema; stale
//             turns (a cited file changed) are warnings like stale lenses
//   warnings  stale lenses / flows / turns (errors with `strict`), stale ultraindex
//             prose, globs that match no file, systems / capabilities without
//             a summary
//
// Never prints, never exits.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkCitations, fileLineTable, indexExists, runCheck } from "./engine.js";
import { assembleWithNotes } from "./model/assemble.js";
import { FLOWS_DIR, LENSES_DIR, loadViewInputs, MODEL_FILE, TIMELINE_FILE } from "./model/load.js";
import type { ViewCoverage, ViewStale } from "./model/types.js";
import { conversationFile, loadConversations, staleTurns } from "./chat.js";
import { answerProblems, proseProblems, unknownNode } from "./gates.js";
import { viewPaths } from "./paths.js";

/** Share of code files the systems must hold. Fixed on purpose: a map is only as good as its coverage. */
export const FILES_IN_SYSTEMS_MIN = 0.9;
/** Share of non-test code modules the capabilities must claim. */
export const MODULES_IN_CAPABILITIES_MIN = 0.7;

export interface CheckIssue {
  /** Repo-relative file the issue is in (`.ultraview/model.json`). */
  file: string;
  /** JSON-pointer-ish location inside it (`capabilities[2].members[0]`), "" for the whole file. */
  path: string;
  message: string;
}

/** A conversation with stale turns: its id and the turns' 0-based indices (as `chat show --json` gives them). */
export interface StaleConversation {
  id: string;
  turns: number[];
}

export interface CheckReport {
  repo: string;
  ok: boolean;
  errors: CheckIssue[];
  warnings: CheckIssue[];
  coverage: ViewCoverage;
  thresholds: ViewCoverage;
  /** The view's stale lenses / flows / prose, and the conversations whose turns went stale. */
  stale: ViewStale & { conversations: StaleConversation[] };
}

export interface CheckMapOptions {
  /** Stale lenses / flows fail the check instead of warning. */
  strict?: boolean;
}

const THRESHOLDS: ViewCoverage = { filesInSystems: FILES_IN_SYSTEMS_MIN, modulesInCapabilities: MODULES_IN_CAPABILITIES_MIN };

/** One issue as one line: `file path: message`. */
export function formatIssue(i: CheckIssue): string {
  return `${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function checkMap(repoArg: string, opts: CheckMapOptions = {}): CheckReport {
  const repo = resolve(repoArg);
  if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`);
  const paths = viewPaths(repo);
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  let view: ReturnType<typeof assembleWithNotes>["view"] | undefined;
  let staleConversations: StaleConversation[] = [];
  const report = (): CheckReport => ({
    repo,
    ok: errors.length === 0,
    errors,
    warnings,
    coverage: view?.coverage ?? { filesInSystems: 0, modulesInCapabilities: 0 },
    thresholds: THRESHOLDS,
    stale: { ...(view?.stale ?? { lenses: [], flows: [], prose: [] }), conversations: staleConversations },
  });

  if (!indexExists(paths.index)) {
    errors.push({ file: ".ultraindex", path: "", message: "no ultraindex index: run `ultraview build` first" });
    return report();
  }
  const idx = runCheck(paths.index, paths.repo);
  if (idx.stale) {
    errors.push({
      file: ".ultraindex",
      path: "",
      message: `index is stale (${idx.changed.length} changed, ${idx.added.length} added, ${idx.removed.length} removed): run \`ultraview build\`, then check again`,
    });
  }
  if (!existsSync(paths.facts)) errors.push({ file: ".ultraview/facts.json", path: "", message: "missing: run `ultraview build`" });
  if (!existsSync(paths.model)) errors.push({ file: MODEL_FILE, path: "", message: "missing: write it (systems first, then capabilities)" });

  const loaded = loadViewInputs(repo);
  errors.push(...loaded.problems);
  const assembled = assembleWithNotes(loaded.inputs);
  view = assembled.view;
  const ids = new Set(view.nodes.map((n) => n.id));
  const { model, flows, lenses, timeline, graph } = loaded.inputs;
  const lineTable = fileLineTable(graph);

  const resolveId = (file: string, path: string, id: string | undefined) => {
    if (id !== undefined && !ids.has(id)) errors.push({ file, path, message: unknownNode(id) });
  };
  const prose = (file: string, path: string, text: string | undefined) => {
    for (const p of proseProblems(path, text, lineTable)) errors.push({ file, ...p });
  };

  if (model) {
    prose(MODEL_FILE, "app.summary", model.app.summary);
    model.systems.forEach((s, i) => {
      if (s.summary === undefined) warnings.push({ file: MODEL_FILE, path: `systems[${i}]`, message: `system "${s.id}" has no summary` });
      prose(MODEL_FILE, `systems[${i}].summary`, s.summary);
    });
    model.capabilities.forEach((c, i) => {
      if (c.summary === undefined) warnings.push({ file: MODEL_FILE, path: `capabilities[${i}]`, message: `capability "${c.id}" has no summary` });
      prose(MODEL_FILE, `capabilities[${i}].summary`, c.summary);
      (c.members ?? []).forEach((m, j) => resolveId(MODEL_FILE, `capabilities[${i}].members[${j}]`, m));
    });
    (model.edges ?? []).forEach((e, i) => {
      resolveId(MODEL_FILE, `edges[${i}].from`, e.from);
      resolveId(MODEL_FILE, `edges[${i}].to`, e.to);
      if (e.cite === undefined) {
        errors.push({ file: MODEL_FILE, path: `edges[${i}]`, message: "a hand-written edge needs a `cite` (path:line it rests on)" });
        return;
      }
      const c = checkCitations(`[${e.cite}]`, lineTable);
      if (c.unresolved.length) errors.push({ file: MODEL_FILE, path: `edges[${i}].cite`, message: `dead citation [${e.cite}]: ${c.unresolved[0]!.reason}` });
      else if (!c.resolved.length || !lineTable.has(c.resolved[0]!.path))
        errors.push({ file: MODEL_FILE, path: `edges[${i}].cite`, message: `"${e.cite}" is not an indexed path:line` });
    });
    (model.tour ?? []).forEach((t, i) => {
      resolveId(MODEL_FILE, `tour[${i}].node`, t.node);
      prose(MODEL_FILE, `tour[${i}].note`, t.note);
    });
    (model.glossary ?? []).forEach((g, i) => prose(MODEL_FILE, `glossary[${i}].meaning`, g.meaning));
    for (const g of assembled.emptyGlobs) warnings.push({ file: MODEL_FILE, path: g.path, message: `glob "${g.glob}" matches no indexed file` });

    if (view.coverage.filesInSystems < FILES_IN_SYSTEMS_MIN) {
      errors.push({
        file: MODEL_FILE,
        path: "systems",
        message: `systems hold ${pct(view.coverage.filesInSystems)} of code files, below ${pct(FILES_IN_SYSTEMS_MIN)}: widen \`paths\` (\`ultraview show sys:_unassigned\` lists the rest)`,
      });
    }
    if (view.coverage.modulesInCapabilities < MODULES_IN_CAPABILITIES_MIN) {
      errors.push({
        file: MODEL_FILE,
        path: "capabilities",
        message: `capabilities claim ${pct(view.coverage.modulesInCapabilities)} of non-test code modules, below ${pct(MODULES_IN_CAPABILITIES_MIN)}: add members (\`ultraview show cap:_foundations\` lists the unclaimed)`,
      });
    }
  }

  for (const f of flows) {
    const file = `${FLOWS_DIR}/${f.id}.json`;
    resolveId(file, "trigger", f.trigger);
    f.steps.forEach((s, i) => {
      resolveId(file, `steps[${i}].node`, s.node);
      prose(file, `steps[${i}].note`, s.note);
    });
    if (!f.sources) warnings.push({ file, path: "sources", message: "not stamped: save it with `ultraview flow save`" });
  }
  for (const l of lenses) {
    const file = `${LENSES_DIR}/${l.id}.json`;
    for (const p of answerProblems(l, ids, lineTable)) errors.push({ file, ...p });
    if (!l.sources) warnings.push({ file, path: "sources", message: "not stamped: save it with `ultraview lens save`" });
  }
  const chats = loadConversations(repo);
  errors.push(...chats.problems);
  for (const c of chats.conversations) {
    const file = conversationFile(c.id);
    c.turns.forEach((t, i) => {
      for (const p of answerProblems(t.answer, ids, lineTable, `turns[${i}].answer.`)) errors.push({ file, ...p });
      if (t.context?.node !== undefined) resolveId(file, `turns[${i}].context.node`, t.context.node);
    });
  }
  // An `auto` summary is generated from a change set's counts, not written: it has nothing to cite.
  timeline.forEach((t, i) => {
    if (!t.auto) prose(TIMELINE_FILE, `line ${i + 1}.summary`, t.summary);
  });

  const staleSink = opts.strict ? errors : warnings;
  for (const id of view.stale.lenses)
    staleSink.push({
      file: `${LENSES_DIR}/${id}.json`,
      path: "",
      message: "stale: a cited file changed since it was saved; re-ask, then `ultraview lens save`",
    });
  for (const id of view.stale.flows)
    staleSink.push({
      file: `${FLOWS_DIR}/${id}.json`,
      path: "",
      message: "stale: a cited file changed since it was saved; re-check, then `ultraview flow save`",
    });
  staleConversations = chats.conversations.map((c) => ({ id: c.id, turns: staleTurns(repo, c) })).filter((c) => c.turns.length);
  for (const c of staleConversations)
    for (const i of c.turns)
      staleSink.push({
        file: conversationFile(c.id),
        path: `turns[${i}]`,
        message: `stale: a cited file changed since turn ${i + 1} was saved; ask it again in the thread (\`ultraview lens new --thread ${c.id}\`)`,
      });
  for (const id of view.stale.prose)
    warnings.push({ file: ".ultraindex", path: id, message: "ultraindex prose is stale (the module's code changed since it was written)" });

  return report();
}
