// The thin I/O layer in front of the pure assembler: read the ultraindex index,
// facts.json and the agent-authored files under .ultraview/, validate what the
// agent wrote, and hand `assembleView` plain values.
//
// Invalid agent files never break the map: they are left out of the inputs and
// reported as problems, which `check` turns into errors and `build` into a
// one-line warning.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { codeindex, type Graph, indexPaths, loadEnrichedProse, loadGraph, loadSymbols, runStatus } from "../engine.js";
import { emptyFacts } from "../extract/index.js";
import type { Facts } from "../extract/types.js";
import { originRemote } from "../git.js";
import { VIEW_DIR, viewPaths } from "../paths.js";
import type { ViewInputs } from "./assemble.js";
import { CHANGE_SCHEMA, type ChangeSet, type Flow, type Insight, type Lens, type Model, type TimelineEntry } from "./types.js";
import { type Problem, parseJson, validateFlow, validateLens, validateModel, validateTimelineEntry } from "./validate.js";

/** A problem in one agent-authored file. `file` is repo-relative. */
export interface FileProblem extends Problem {
  file: string;
}

export interface LoadedInputs {
  inputs: ViewInputs;
  problems: FileProblem[];
  /** Whether model.json exists at all (valid or not). */
  hasModel: boolean;
}

export interface LoadOverrides {
  /** The graph `build` just computed, instead of re-reading graph.json. */
  graph?: Graph;
  /** The facts `build` just extracted, instead of re-reading facts.json. */
  facts?: Facts;
  /** Repo-relative path → commits touching it in the churn window (`build` computes it; default: none). */
  churn?: Map<string, number>;
  /** Insights `build` computed (default: none). */
  insights?: Insight[];
}

export const MODEL_FILE = `${VIEW_DIR}/model.json`;
export const FLOWS_DIR = `${VIEW_DIR}/flows`;
export const LENSES_DIR = `${VIEW_DIR}/lenses`;
export const TIMELINE_FILE = `${VIEW_DIR}/timeline.jsonl`;
export const CHANGES_DIR = `${VIEW_DIR}/changes`;

/** sha256 (hex) of a file's current bytes, or null when it cannot be read. */
export function fileSha256(abs: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function readAgentJson<T>(repo: string, rel: string, validate: (v: unknown) => Problem[], problems: FileProblem[], stem?: string): T | undefined {
  const { value, problems: syntax } = parseJson(readFileSync(join(repo, rel), "utf8"));
  const found = syntax.length ? syntax : validate(value);
  const id = (value as { id?: unknown } | undefined)?.id;
  if (!found.length && stem !== undefined && id !== stem) found.push({ path: "id", message: `"${String(id)}" must match the file name (${stem}.json)` });
  for (const p of found) problems.push({ file: rel, ...p });
  return found.length ? undefined : (value as T);
}

function readDir<T>(repo: string, dirRel: string, validate: (v: unknown) => Problem[], problems: FileProblem[]): T[] {
  const abs = join(repo, dirRel);
  if (!existsSync(abs)) return [];
  const out: T[] = [];
  for (const name of readdirSync(abs)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const item = readAgentJson<T>(repo, `${dirRel}/${name}`, validate, problems, basename(name, ".json"));
    if (item) out.push(item);
  }
  return out;
}

/** Every valid timeline entry, in file order (oldest first); invalid lines reported into `problems`. */
export function readTimeline(repo: string, problems: FileProblem[] = []): TimelineEntry[] {
  const abs = join(repo, TIMELINE_FILE);
  if (!existsSync(abs)) return [];
  const out: TimelineEntry[] = [];
  readFileSync(abs, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      const { value, problems: syntax } = parseJson(line);
      const found = syntax.length ? syntax : validateTimelineEntry(value);
      for (const p of found) problems.push({ file: TIMELINE_FILE, path: `line ${i + 1}${p.path ? `.${p.path}` : ""}`, message: p.message });
      if (!found.length) out.push(value as TimelineEntry);
    });
  return out;
}

/** Change set ids, oldest first (ids start with their UTC time, so name order is time order). */
export function changeIds(repo: string): string[] {
  const abs = join(repo, CHANGES_DIR);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => n.endsWith(".json"))
    .map((n) => basename(n, ".json"))
    .sort();
}

/** A recorded change set by id, or undefined when absent or not a change set. */
export function readChange(repo: string, id: string): ChangeSet | undefined {
  const { value } = parseJson(readFileSync(join(repo, CHANGES_DIR, `${id}.json`), "utf8"));
  const c = value as Partial<ChangeSet> | undefined;
  return c && c.schema === CHANGE_SCHEMA && c.id === id && Array.isArray(c.nodes) && c.counts && c.base && c.head ? (c as ChangeSet) : undefined;
}

/** The latest valid recorded change set, or null. */
export function latestChange(repo: string): ChangeSet | null {
  const ids = changeIds(repo);
  for (let i = ids.length - 1; i >= 0; i--) {
    const c = readChange(repo, ids[i]!);
    if (c) return c;
  }
  return null;
}

const BUSINESS_RE = /<!--\s*ui:human\s+key=business\s*-->\r?\n([\s\S]*?)\r?\n<!--\s*\/ui:human\s+key=business\s*-->/;

/** Module slug → the enriched `business` prose of its encyclopedia entry (modules ultraindex reports enriched). */
function readModuleProse(indexDir: string, graph: Graph): Map<string, string> {
  const out = new Map<string, string>();
  const enriched = loadEnrichedProse(indexDir, graph);
  const dir = indexPaths(indexDir).encyclopedia;
  for (const slug of [...enriched.keys()].sort()) {
    let text: string;
    try {
      text = readFileSync(join(dir, `${slug}.md`), "utf8");
    } catch {
      continue;
    }
    const body = BUSINESS_RE.exec(text)?.[1]?.trim();
    if (body && !body.includes("<!-- ui:enrich -->")) out.set(slug, body);
  }
  return out;
}

/** Load everything `assembleView` needs. Throws when there is no index. */
export function loadViewInputs(repo: string, overrides: LoadOverrides = {}): LoadedInputs {
  const paths = viewPaths(repo);
  const graph = overrides.graph ?? loadGraph(paths.index);
  if (!graph) throw new Error(`no ultraindex index at ${paths.index}: run \`ultraview build\` first`);
  const problems: FileProblem[] = [];

  let facts = overrides.facts;
  if (!facts) {
    facts = emptyFacts();
    if (existsSync(paths.facts)) {
      const parsed = parseJson(readFileSync(paths.facts, "utf8"));
      if (!parsed.problems.length) facts = { ...facts, ...(parsed.value as Facts) };
    }
  }

  const hasModel = existsSync(paths.model);
  const model = hasModel ? readAgentJson<Model>(repo, MODEL_FILE, validateModel, problems) : undefined;
  const flows = readDir<Flow>(repo, FLOWS_DIR, validateFlow, problems);
  const lenses = readDir<Lens>(repo, LENSES_DIR, validateLens, problems);
  const timeline = readTimeline(repo, problems);

  const currentHashes = new Map<string, string | null>();
  for (const item of [...flows, ...lenses]) {
    for (const path of Object.keys(item.sources ?? {})) if (!currentHashes.has(path)) currentHashes.set(path, fileSha256(join(repo, path)));
  }

  const proseStale = (runStatus(paths.index)?.modules ?? []).filter((m) => m.prose === "stale").map((m) => m.slug);
  const workspaces = codeindex.detectWorkspaces(repo).packages.map((p) => ({ name: p.name, dir: p.dir }));

  return {
    inputs: {
      repoName: basename(repo),
      root: resolve(repo),
      remote: originRemote(repo),
      commit: graph.commit ?? codeindex.headCommit(repo),
      graph,
      symbols: loadSymbols(paths.index),
      facts,
      model,
      workspaces,
      flows,
      lenses,
      timeline,
      moduleProse: readModuleProse(paths.index, graph),
      proseStale,
      currentHashes,
      churn: overrides.churn ?? new Map(),
      changes: latestChange(repo),
      insights: overrides.insights ?? [],
    },
    problems,
    hasModel,
  };
}
