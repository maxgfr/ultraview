// `ultraview status`: where the repo stands, and what the agent does next
// (docs/design.md §7). Situations, in routing order — the first that holds wins:
//
//   no-index          no ultraindex index yet                → build
//   index-stale       sources changed since the index, or facts.json missing → build
//   no-model          .ultraview/model.json absent          → write the model
//   model-incomplete  `check` fails: schema, ids, citations or coverage → fix the model
//   stale-views       `check` passes but warns: lenses / conversation turns / flows / prose went stale → re-ask
//   ready             nothing to do
//
// Each situation is a probe; a later milestone adds its probe to PROBES and
// nothing else changes. On top of the situation, a cheap git check notes work
// that differs from the last recorded change set (once one was recorded).
// Never prints, never exits.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { unrecordedChanges } from "./changes.js";
import { type CheckReport, checkMap, formatIssue } from "./check.js";
import { indexExists, runCheck } from "./engine.js";
import { viewPaths, type ViewPaths } from "./paths.js";

export const SITUATIONS = ["no-index", "index-stale", "no-model", "model-incomplete", "stale-views", "ready"] as const;
export type Situation = (typeof SITUATIONS)[number];

export interface IndexState {
  exists: boolean;
  stale: boolean;
  changed: number;
  added: number;
  removed: number;
  errors: string[];
}

export interface StatusReport {
  repo: string;
  situation: Situation;
  /** Why this situation holds, one line each. */
  reasons: string[];
  /** What to do next, in order. */
  worklist: string[];
  index: IndexState;
  facts: { exists: boolean };
  model: { exists: boolean };
  /** The check gate's verdict, when status ran it: counts, coverage, and what went stale (lenses, conversation turns, flows, prose). */
  check?: { ok: boolean; errors: number; warnings: number; coverage: CheckReport["coverage"]; stale: CheckReport["stale"] };
  /** Changes since the last recorded change set (only once one was recorded): its id and mode. */
  unrecorded?: { last: string; mode: string };
}

/** What every probe can look at, computed once. */
export interface StatusInputs {
  paths: ViewPaths;
  index: IndexState;
  facts: { exists: boolean };
  model: { exists: boolean };
  /** The check gate's report, computed on first use (only once the index is fresh and a model exists). */
  check: () => CheckReport;
}

export interface ProbeHit {
  situation: Situation;
  reasons: string[];
  worklist: string[];
}

export type Probe = (inputs: StatusInputs) => ProbeHit | undefined;

const build = (s: StatusInputs) => `run \`ultraview build --repo ${s.paths.repo}\``;

const noIndex: Probe = (s) => (s.index.exists ? undefined : { situation: "no-index", reasons: ["no ultraindex index at .ultraindex/"], worklist: [build(s)] });

const indexStale: Probe = (s) => {
  const reasons: string[] = [];
  if (s.index.errors.length) reasons.push(...s.index.errors);
  if (s.index.stale) reasons.push(`index is stale: ${s.index.changed} changed, ${s.index.added} added, ${s.index.removed} removed file(s)`);
  if (!s.facts.exists) reasons.push("no .ultraview/facts.json yet");
  return reasons.length ? { situation: "index-stale", reasons, worklist: [build(s)] } : undefined;
};

const noModel: Probe = (s) =>
  s.model.exists
    ? undefined
    : {
        situation: "no-model",
        reasons: ["no .ultraview/model.json"],
        worklist: ["read the build summary, then write .ultraview/model.json (systems first, then capabilities, every sentence citing [path:line])"],
      };

/** Worklist items shown per situation, at most. */
export const WORKLIST_MAX = 10;

const worklistOf = (issues: CheckReport["errors"], tail: string): string[] => {
  const items = issues.slice(0, WORKLIST_MAX).map(formatIssue);
  if (issues.length > WORKLIST_MAX) items.push(`… and ${issues.length - WORKLIST_MAX} more: run \`ultraview check\``);
  items.push(tail);
  return items;
};

const modelIncomplete: Probe = (s) => {
  const c = s.check();
  if (c.ok) return undefined;
  return {
    situation: "model-incomplete",
    reasons: [
      `check fails with ${c.errors.length} error(s)`,
      `coverage: files in systems ${(c.coverage.filesInSystems * 100).toFixed(1)}% (min ${c.thresholds.filesInSystems * 100}%), modules in capabilities ${(c.coverage.modulesInCapabilities * 100).toFixed(1)}% (min ${c.thresholds.modulesInCapabilities * 100}%)`,
    ],
    worklist: worklistOf(c.errors, "run `ultraview check` until it passes"),
  };
};

/** `orders (turn 1)`, `orders (turns 1, 3)`: turns counted from 1, as `chat show` numbers them. */
const staleTurnsLine = (c: CheckReport["stale"]["conversations"][number]) =>
  `${c.id} (turn${c.turns.length > 1 ? "s" : ""} ${c.turns.map((i) => i + 1).join(", ")})`;

const staleViews: Probe = (s) => {
  const c = s.check();
  const stale = c.stale.lenses.length + c.stale.conversations.length + c.stale.flows.length + c.stale.prose.length;
  if (!stale) return undefined;
  const reasons: string[] = [];
  if (c.stale.lenses.length) reasons.push(`stale lenses: ${c.stale.lenses.join(", ")}`);
  if (c.stale.conversations.length) reasons.push(`stale conversation turns: ${c.stale.conversations.map(staleTurnsLine).join(", ")}`);
  if (c.stale.flows.length) reasons.push(`stale flows: ${c.stale.flows.join(", ")}`);
  if (c.stale.prose.length) reasons.push(`stale module prose: ${c.stale.prose.join(", ")}`);
  const staleWarnings = c.warnings.filter((w) => w.message.includes("stale"));
  return { situation: "stale-views", reasons, worklist: worklistOf(staleWarnings, "re-ask only what is stale, save it, then `ultraview check`") };
};

/** Routing order: the first probe that hits wins. */
export const PROBES: readonly Probe[] = [noIndex, indexStale, noModel, modelIncomplete, staleViews];

function indexState(paths: ViewPaths): IndexState {
  if (!indexExists(paths.index)) return { exists: false, stale: false, changed: 0, added: 0, removed: 0, errors: [] };
  const check = runCheck(paths.index, paths.repo);
  return {
    exists: true,
    stale: check.stale,
    changed: check.changed.length,
    added: check.added.length,
    removed: check.removed.length,
    errors: check.errors,
  };
}

export function readStatus(repoArg: string, probes: readonly Probe[] = PROBES): StatusReport {
  const repo = resolve(repoArg);
  if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`);
  const paths = viewPaths(repo);
  let report: CheckReport | undefined;
  const inputs: StatusInputs = {
    paths,
    index: indexState(paths),
    facts: { exists: existsSync(paths.facts) },
    model: { exists: existsSync(paths.model) },
    check: () => (report ??= checkMap(repo)),
  };
  let hit: ProbeHit = { situation: "ready", reasons: ["index fresh, model checks clean, nothing stale"], worklist: [] };
  for (const probe of probes) {
    const h = probe(inputs);
    if (h) {
      hit = h;
      break;
    }
  }
  // Not a situation of its own: a note on top of whichever holds.
  const unrecorded = unrecordedChanges(repo);
  if (unrecorded) {
    hit.reasons = [...hit.reasons, `the ${unrecorded.mode} differs from the last recorded change (${unrecorded.last})`];
    hit.worklist = [...hit.worklist, `record it: \`ultraview diff ${unrecorded.mode === "base" ? "" : `--${unrecorded.mode} `}--record\``];
  }
  return {
    repo,
    ...hit,
    index: inputs.index,
    facts: inputs.facts,
    model: inputs.model,
    ...(report
      ? { check: { ok: report.ok, errors: report.errors.length, warnings: report.warnings.length, coverage: report.coverage, stale: report.stale } }
      : {}),
    ...(unrecorded ? { unrecorded } : {}),
  };
}
