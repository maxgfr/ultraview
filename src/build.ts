// `ultraview build`, as a library call: refresh the ultraindex index
// (incremental), run the extractors over the files it indexed, read the git
// history (churn) and the engine's insights, merge everything into the
// view-model, and write `.ultraview/facts.json`, `.ultraview/view.json` plus
// `.ultraview/.gitignore`.
//
// Never prints, never exits: the result comes back as a value and the CLI
// decides what to say (src/cli.ts, src/summary.ts).

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { codeindex, type Graph, loadManifest, prepareGrammars, runBuild } from "./engine.js";
import { type ExtractorFailure, type Facts, runExtractors } from "./extract/index.js";
import { insightsOf, repoHistory } from "./insights.js";
import { stableJson } from "./json.js";
import { assembleView } from "./model/assemble.js";
import { type FileProblem, loadViewInputs } from "./model/load.js";
import type { ViewCoverage } from "./model/types.js";
import { GENERATED_FILES, VIEW_DIR, viewPaths } from "./paths.js";

export interface MapBuildOptions {
  repo: string;
  /** Load the tree-sitter grammars first (AST-exact symbols). Default true; false = the engine's regex extractor. */
  ast?: boolean;
  /** Build timestamp handed to ultraindex's manifest. Default: now. */
  builtAt?: string;
}

export interface ModuleRank {
  slug: string;
  path: string;
  files: number;
  pagerank: number;
}

export interface WorkspaceSummary {
  name: string;
  dir: string;
  kind: string;
}

export interface MapBuildResult {
  repo: string;
  name: string;
  index: {
    out: string;
    files: number;
    modules: number;
    edges: number;
    languages: Record<string, number>;
    capped: boolean;
  };
  grammars: { ast: boolean; tier?: string; notes: string[] };
  workspaces: WorkspaceSummary[];
  topModules: ModuleRank[];
  facts: Facts;
  failures: ExtractorFailure[];
  /** Whether .ultraview/model.json exists (decides the next step). */
  hasModel: boolean;
  /** What went into .ultraview/view.json. */
  view: ViewBuildSummary;
  /** Files written, repo-relative. */
  written: string[];
}

export interface ViewBuildSummary {
  nodes: number;
  edges: number;
  coverage: ViewCoverage;
  bytes: number;
  /** view.json is over VIEW_SIZE_WARN_BYTES: the viewer will be slow. */
  oversize: boolean;
  /** Agent-authored files left out of the view because they are invalid (run `check`). */
  problems: FileProblem[];
}

/** Warn past this view.json size (docs/design.md §6). */
export const VIEW_SIZE_WARN_BYTES = 15 * 1024 * 1024;

/** Our own files never enter the index: model edits must not make it stale. */
const VIEW_EXCLUDE = `${VIEW_DIR}/**`;

export const GITIGNORE_BODY = `# Written by \`ultraview build\`: regenerable files, never committed.\n${GENERATED_FILES.join("\n")}\n`;

/** Top modules by PageRank (ties by slug), from the graph ultraindex just wrote. */
export function topModules(graph: Graph, n = 10): ModuleRank[] {
  return [...graph.modules]
    .sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, n)
    .map((m) => ({ slug: m.slug, path: m.path, files: m.members.length, pagerank: m.pagerank ?? 0 }));
}

function readSource(abs: string): string | undefined {
  try {
    return codeindex.readText(abs);
  } catch {
    return undefined;
  }
}

export async function buildMap(opts: MapBuildOptions): Promise<MapBuildResult> {
  const repo = resolve(opts.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`repo not found: ${repo}`);
  const paths = viewPaths(repo);

  const grammars: MapBuildResult["grammars"] = { ast: false, notes: [] };
  if (opts.ast !== false) {
    // Honors CODEINDEX_NO_GRAMMARS_PULL=1 (no network): falls back to the regex tier.
    const warm = await prepareGrammars({ label: "ultraview", onNote: () => {} });
    grammars.ast = warm.ready;
    grammars.tier = warm.tier;
    grammars.notes = warm.notes;
  }

  // Reuse the scan options an existing index was built with (ultraindex's own
  // `build --include/--exclude`), adding only our exclusion.
  const scan = loadManifest(paths.index)?.scan;
  const exclude = [...new Set([...(scan?.exclude ?? []), VIEW_EXCLUDE])].sort();
  const built = runBuild(
    {
      repo,
      out: paths.index,
      include: scan?.include,
      exclude,
      maxBytes: scan?.maxBytes,
      maxFiles: scan?.maxFiles,
      ...(scan?.gitignore === false ? { gitignore: false } : {}),
      mermaid: true,
      json: false,
    },
    opts.builtAt ?? new Date().toISOString(),
  );
  const graph = built.graph;

  // The graph's file list is the scan: no second walk. Minified or bundled
  // files are skipped — they are build output, not the app.
  const files = graph.files.filter((f) => !f.generated).map((f) => f.rel);
  const failures: ExtractorFailure[] = [];
  const facts = runExtractors(repo, files, readSource, { onError: (f) => failures.push(f) });

  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.facts, stableJson(facts));
  writeFileSync(paths.gitignore, GITIGNORE_BODY);

  const history = repoHistory(repo);
  const insights = insightsOf(repo, { graph, history });
  const loaded = loadViewInputs(repo, { graph, facts, churn: history.churn, insights });
  const view = assembleView(loaded.inputs);
  const viewText = stableJson(view);
  writeFileSync(paths.view, viewText);
  const bytes = Buffer.byteLength(viewText);

  const ws = codeindex.detectWorkspaces(repo);
  const workspaces = ws.packages
    .map((p) => ({ name: p.name, dir: p.dir, kind: p.kind }))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.name < b.name ? -1 : 1));

  return {
    repo,
    name: basename(repo),
    index: {
      out: paths.index,
      files: graph.fileCount,
      modules: graph.modules.length,
      edges: graph.fileEdges.length,
      languages: graph.languages,
      capped: built.capped,
    },
    grammars,
    workspaces,
    topModules: topModules(graph),
    facts,
    failures,
    hasModel: existsSync(paths.model),
    view: {
      nodes: view.nodes.length,
      edges: view.edges.length,
      coverage: view.coverage,
      bytes,
      oversize: bytes > VIEW_SIZE_WARN_BYTES,
      problems: loaded.problems,
    },
    written: [`${VIEW_DIR}/facts.json`, `${VIEW_DIR}/view.json`, `${VIEW_DIR}/.gitignore`],
  };
}
