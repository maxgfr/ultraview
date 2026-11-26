// The cheap re-assembly `serve` and `render` share: the view-model from the
// agent files as they stand now (model.json, flows/, lenses/, timeline.jsonl,
// changes/) over the index and facts.json the last `build` left. No
// re-indexing, no extractor run, no git history walk.
//
// What only `build` computes — churn from git and the engine's insights — is
// carried over from the view.json it wrote, so a re-assembly with nothing new
// to show gives back the same bytes. Never prints, never exits.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCheck } from "./engine.js";
import { stableJson } from "./json.js";
import { type AssembleResult, assembleWithNotes } from "./model/assemble.js";
import { type LoadedInputs, type LoadOverrides, loadViewInputs } from "./model/load.js";
import { type Insight, VIEW_SCHEMA, type ViewModel, type ViewNode } from "./model/types.js";
import { viewPaths } from "./paths.js";

export interface FreshView {
  view: ViewModel;
  /** The view as view.json holds it (stableJson). */
  text: string;
  assembled: AssembleResult;
  loaded: LoadedInputs;
  byId: Map<string, ViewNode>;
}

export interface StaleState {
  /** The index no longer matches the source files: run `ultraview build`. */
  index: boolean;
  changed: number;
  added: number;
  removed: number;
  /** The first few files concerned. */
  files: string[];
}

/** Churn and insights from a view.json `build` wrote; nothing when the text is absent or not a view. */
export function carriedOver(viewText: string | undefined): Pick<LoadOverrides, "churn" | "insights"> {
  if (viewText === undefined) return {};
  let prev: Partial<ViewModel> | null;
  try {
    prev = JSON.parse(viewText) as Partial<ViewModel> | null;
  } catch {
    return {};
  }
  if (!prev || prev.schema !== VIEW_SCHEMA || !Array.isArray(prev.nodes)) return {};
  const churn = new Map<string, number>();
  for (const n of prev.nodes) {
    const c = n?.metrics?.churn;
    if (n?.kind === "file" && typeof n.id === "string" && n.id.startsWith("file:") && typeof c === "number" && c > 0) churn.set(n.id.slice(5), c);
  }
  const insights: Insight[] = Array.isArray(prev.insights) ? prev.insights : [];
  return { churn, insights };
}

function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** The view re-assembled from the current agent files (throws when there is no index). */
export function freshView(repoArg: string): FreshView {
  const repo = resolve(repoArg);
  const loaded = loadViewInputs(repo, carriedOver(readText(viewPaths(repo).view)));
  const assembled = assembleWithNotes(loaded.inputs);
  const view = assembled.view;
  return { view, text: stableJson(view), assembled, loaded, byId: new Map(view.nodes.map((n) => [n.id, n])) };
}

/** Write view.json atomically, only when its bytes change; true when it was written. */
export function writeView(file: string, text: string): boolean {
  if (readText(file) === text) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return true;
}

/** Whether the index still matches the source files (ultraindex check: hashes, no re-indexing). */
export function indexStaleness(repoArg: string): StaleState {
  const repo = resolve(repoArg);
  const r = runCheck(viewPaths(repo).index, repo);
  return {
    index: r.stale,
    changed: r.changed.length,
    added: r.added.length,
    removed: r.removed.length,
    files: [...r.changed, ...r.added, ...r.removed].slice(0, 20),
  };
}
