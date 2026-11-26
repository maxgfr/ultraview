// `ultraview status`: where the repo stands, and what the agent does next
// (docs/design.md §7). Situations, in routing order — the first that holds wins:
//
//   no-index          no ultraindex index yet                → build
//   index-stale       sources changed since the index, or facts.json missing → build
//   no-model          .ultraview/model.json absent          → write the model
//   model-incomplete  model fails coverage / citations      (M2)
//   stale-views       lenses / flows cite changed files     (M3)
//   ready             nothing to do
//
// Each situation is a probe; a later milestone adds its probe to PROBES and
// nothing else changes. Never prints, never exits.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
}

/** What every probe can look at, computed once. */
export interface StatusInputs {
  paths: ViewPaths;
  index: IndexState;
  facts: { exists: boolean };
  model: { exists: boolean };
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

/** Routing order. M2 adds `model-incomplete` after `noModel`; M3 adds `stale-views`. */
export const PROBES: readonly Probe[] = [noIndex, indexStale, noModel];

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
  const inputs: StatusInputs = {
    paths,
    index: indexState(paths),
    facts: { exists: existsSync(paths.facts) },
    model: { exists: existsSync(paths.model) },
  };
  let hit: ProbeHit = { situation: "ready", reasons: ["index fresh, model present"], worklist: [] };
  for (const probe of probes) {
    const h = probe(inputs);
    if (h) {
      hit = h;
      break;
    }
  }
  return { repo, ...hit, index: inputs.index, facts: inputs.facts, model: inputs.model };
}
