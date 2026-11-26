// `ultraview diff`, as library calls (docs/design.md §6, §7): the engine's
// delta (codeindex readDeltaDiff + deltaOfDiff, decorated by ultraindex
// withEntries) mapped onto the view's node ids at every level, then optionally
// recorded as `.ultraview/changes/<id>.json` plus one timeline line.
//
//   file      added / changed (modified, renamed) / removed from git; impacted =
//             the blast radius (reverse dependency closure within `depth` hops,
//             importers of a removed file included) that is not itself changed
//   sym       exported top-level symbols the changed hunks touch
//   route / screen / entity / job
//             facts of the new tree against facts of the base tree (the
//             extractors re-run over the base contents): new id → added, gone →
//             removed, same id with a different definition or a changed hunk in
//             the lines it owns (its extent `[line, end]`: the registering call,
//             handler, model block; a hunk of blank or comment-only lines owns
//             nothing) → changed, else impacted when its file is changed or
//             impacted
//   mod / sys / cap
//             rolled up from their files (a module slice, its system, every
//             capability the file serves): changed when a file under it is,
//             added when every file under it is new, removed when it left the
//             map, impacted when only impacted files sit under it
//
// Deterministic: the same repository state gives the same change set, apart
// from `id` and `at` (the record time). Never prints, never exits.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { buildMap } from "./build.js";
import { codeindex, type DeltaResult, type Graph, indexExists, loadGraph, loadManifest, runCheck, withEntries } from "./engine.js";
import { blankOrCommentOnly, type ExtentOf, extentFinder } from "./extract/extent.js";
import { runExtractors } from "./extract/index.js";
import type { Facts } from "./extract/types.js";
import { fileAt, headState } from "./git.js";
import { stableJson, stableLine, writeFileAtomic } from "./json.js";
import { MERMAID_MAX_EDGES, MERMAID_MAX_NODES, mermaidFlowchart, type PickedEdge } from "./mermaid.js";
import { assembleWithNotes, humanizeSegment, systemOfFile, systemRules, timelineNewestFirst } from "./model/assemble.js";
import { entityId, fileId, jobId, modId, parseSlice, routeId, screenId, sliceId, symId, UNASSIGNED_LABEL } from "./model/ids.js";
import { CHANGES_DIR, latestChange, loadViewInputs, readTimeline } from "./model/load.js";
import {
  CHANGE_NODE_KINDS,
  CHANGE_SCHEMA,
  type ChangeCounts,
  type ChangedNode,
  type ChangeNodeKind,
  type ChangeSet,
  type ChangeStatus,
  type DiffMode,
  type ModuleRisk,
  type RiskBucket,
  type TimelineEntry,
  type TimelineItem,
  type TimelineSource,
  type ViewModel,
  type ViewNode,
} from "./model/types.js";
import type { Problem } from "./model/validate.js";
import { INDEX_DIR_NAME, VIEW_DIR, viewPaths } from "./paths.js";
import { indexedScan } from "./scan.js";
import { appendTimeline, summaryProblems } from "./timeline.js";

/** Blast-radius depth when none is asked for (the engine's delta default). */
export const DIFF_DEPTH = codeindex.DEFAULT_DELTA_DEPTH;
/** Above this many changed files, base facts are not re-extracted (removed routes / entities then go unnoticed; a note says so). */
export const BASE_FACTS_MAX_FILES = 500;
/** A recorded timeline entry lists at most this many items (capabilities, systems, modules, facts, then files). */
export const TIMELINE_ITEMS_MAX = 100;

export interface DiffOptions {
  /** Base ref for the default mode (default: origin/HEAD, origin/main, …, as the engine resolves it). */
  base?: string;
  /** Only the staged changes, against HEAD. */
  staged?: boolean;
  /** Everything uncommitted (staged, unstaged, untracked), against HEAD. */
  worktree?: boolean;
  /** Blast-radius depth (default DIFF_DEPTH). */
  depth?: number;
  /** Rebuild the map first when the index or facts are stale (default true). */
  refresh?: boolean;
  /** For that rebuild: load the tree-sitter grammars (default true). */
  ast?: boolean;
  /** Record time, for `id` and `at` (default: now). */
  now?: Date;
}

type GitDelta = Exclude<ReturnType<typeof codeindex.readDeltaDiff>, { error: string }>;

/** The git side of a diff: what changed, before the map is consulted. */
export interface GitDiff {
  mode: DiffMode;
  diff: GitDelta;
  head?: { sha: string; date: string };
  /** Uncommitted (staged or worktree) changes are part of it. */
  dirty: boolean;
  fingerprint: string;
}

export function diffModeOf(opts: Pick<DiffOptions, "staged" | "worktree">): DiffMode {
  return opts.staged ? "staged" : opts.worktree ? "worktree" : "base";
}

const isOwn = (p: string) => p === VIEW_DIR || p.startsWith(`${VIEW_DIR}/`);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function readDiff(repo: string, mode: DiffMode, base: string | undefined, head: GitDiff["head"]): GitDelta {
  const ref = mode === "worktree" ? (head ? "HEAD" : undefined) : mode === "base" ? base : undefined;
  const raw = codeindex.readDeltaDiff(repo, { base: ref, staged: mode === "staged", indexDir: INDEX_DIR_NAME });
  if ("error" in raw) throw new Error(raw.error);
  // ultraview's own files (model, timeline, change sets) are never part of a change.
  const files = raw.files.filter((f) => !isOwn(f.path) && !(f.oldPath !== undefined && isOwn(f.oldPath) && f.status !== "renamed"));
  return { ...raw, files, hunks: new Map([...raw.hunks].filter(([p]) => !isOwn(p))) };
}

function contentHash(repo: string, rel: string): string {
  try {
    return codeindex.sha1(readFileSync(join(repo, rel)));
  } catch {
    return "";
  }
}

/**
 * What git says changed for `mode`, without touching the map: cheap enough to
 * decide whether there is anything (new) to record. Throws outside git.
 */
export function readGitDiff(repoArg: string, opts: Pick<DiffOptions, "base" | "staged" | "worktree"> = {}): GitDiff {
  const repo = resolve(repoArg);
  if (!codeindex.isGitWorktree(repo)) throw new Error(`diff needs a git repository: ${repo} is not inside one`);
  const mode = diffModeOf(opts);
  const head = headState(repo);
  const diff = readDiff(repo, mode, opts.base, head);
  const dirty = mode === "base" ? readDiff(repo, "worktree", undefined, head).files.length > 0 : diff.files.length > 0;
  const files = [...diff.files]
    .sort((a, b) => cmp(a.path, b.path))
    .map((f) => [
      f.path,
      f.status,
      f.oldPath ?? "",
      f.status === "deleted" ? "" : contentHash(repo, f.path),
      (diff.hunks.get(f.path) ?? []).map((h) => `${h.start}-${h.end}`).join(","),
    ]);
  const fingerprint = codeindex.sha1(JSON.stringify({ mode, base: diff.base.mergeBase, head: head?.sha ?? "", files }));
  return { mode, diff, ...(head ? { head } : {}), dirty, fingerprint };
}

/** The index or facts lag behind the working tree. */
export function mapIsStale(repo: string): boolean {
  const paths = viewPaths(repo);
  return !indexExists(paths.index) || !existsSync(paths.facts) || runCheck(paths.index, repo).stale;
}

// --- facts of a tree ---------------------------------------------------------

interface FactRef {
  kind: "route" | "screen" | "entity" | "job";
  label: string;
  file: string;
  line: number;
  /** Last line of the definition, when facts.json carries it. */
  end?: number;
  /** What the definition says besides where it is (key order free): a different signature = a changed fact. */
  sig: string;
}

function factIndex(facts: Facts): Map<string, FactRef> {
  const out = new Map<string, FactRef>();
  const put = (id: string, ref: FactRef) => {
    if (!out.has(id)) out.set(id, ref);
  };
  for (const r of facts.routes) {
    put(routeId(r.method, r.path), {
      kind: "route",
      label: `${r.method.toUpperCase()} ${r.path}`,
      file: r.file,
      line: r.line,
      end: r.end,
      sig: `${r.framework}|${r.handler ?? ""}`,
    });
  }
  for (const s of facts.screens) put(screenId(s.path), { kind: "screen", label: s.path, file: s.file, line: s.line, end: s.end, sig: s.framework });
  for (const e of facts.entities)
    put(entityId(e.name), { kind: "entity", label: e.name, file: e.file, line: e.line, end: e.end, sig: stableLine([e.orm, e.fields]) });
  for (const j of facts.jobs) put(jobId(j.id), { kind: "job", label: j.id, file: j.file, line: j.line, end: j.end, sig: `${j.kind}|${j.schedule ?? ""}` });
  return out;
}

function readSource(abs: string): string | undefined {
  try {
    return codeindex.readText(abs);
  } catch {
    return undefined;
  }
}

/** The extractors over the base tree: unchanged files from disk, changed / removed ones from git at the base commit. */
function baseFacts(repo: string, graph: Graph, delta: DeltaResult, sha: string): Facts {
  const fromGit = new Set<string>();
  const notInBase = new Set<string>();
  for (const c of delta.changes) {
    if (c.status === "added") notInBase.add(c.path);
    else if (c.status === "renamed") {
      notInBase.add(c.path);
      if (c.oldPath !== undefined) fromGit.add(c.oldPath);
    } else fromGit.add(c.path);
  }
  const files = [...new Set([...graph.files.filter((f) => !f.generated && !notInBase.has(f.rel)).map((f) => f.rel), ...fromGit])].sort(cmp);
  const read = (abs: string) => {
    const rel = relative(repo, abs).split(sep).join("/");
    return fromGit.has(rel) ? fileAt(repo, sha, rel) : readSource(abs);
  };
  return runExtractors(repo, files, read);
}

// --- the change set ------------------------------------------------------------

const DIRECT: ReadonlySet<ChangeStatus> = new Set(["added", "changed", "removed"]);
const STATUS_RANK: Record<ChangeStatus, number> = { added: 0, removed: 0, changed: 1, impacted: 2 };

const zeroCounts = (): ChangeCounts => ({ added: 0, changed: 0, removed: 0, impacted: 0 });

/** UTC `YYYYMMDD-HHMMSS`. */
export function stampOf(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
}

export interface ComputedDiff {
  change: ChangeSet;
  /** The view the change was mapped onto (current tree). */
  view: ViewModel;
}

/** Map an already-read git diff onto the (fresh) map. */
export function changeSetOf(repoArg: string, git: GitDiff, opts: Pick<DiffOptions, "depth" | "now"> = {}): ComputedDiff {
  const repo = resolve(repoArg);
  const depth = opts.depth ?? DIFF_DEPTH;
  const loaded = loadViewInputs(repo);
  const { view } = assembleWithNotes(loaded.inputs);
  const { graph, symbols, facts, model, workspaces } = loaded.inputs;
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const notes: string[] = [];
  const delta = withEntries(codeindex.deltaOfDiff(git.diff, graph, symbols, { scan: indexedScan(repo), depth }));

  const nodes = new Map<string, ChangedNode>();
  const put = (n: ChangedNode) => {
    const prev = nodes.get(n.id);
    if (!prev || STATUS_RANK[n.status] < STATUS_RANK[prev.status]) nodes.set(n.id, n);
  };

  // Where a removed file sat: its module slice in the system its globs give it.
  const rules = systemRules(model, workspaces);
  const moduleByPath = new Map(graph.modules.map((m) => [m.path, m.slug]));
  const goneContainers = new Map<string, { label: string; parent?: string }>();
  const removedParent = (rel: string): string => {
    const dir = rel.includes("/") ? posix.dirname(rel) : "(root)";
    const slug = moduleByPath.get(dir) ?? (dir === "(root)" ? "root" : codeindex.slugify(dir));
    const sys = systemOfFile(rules, rel);
    const whole = byId.get(modId(slug));
    const id = whole?.parent === sys ? modId(slug) : byId.has(sliceId(slug, sys)) ? sliceId(slug, sys) : whole ? sliceId(slug, sys) : modId(slug);
    if (!byId.has(id)) goneContainers.set(id, { label: humanizeSegment(dir), parent: sys });
    if (!byId.has(sys)) goneContainers.set(sys, { label: rules.systems.find((s) => s.id === sys)?.label ?? UNASSIGNED_LABEL });
    return id;
  };

  // --- files -------------------------------------------------------------------
  const wasIndexed = indexedPath(repo);
  const direct = new Map<string, ChangeStatus>();
  for (const c of delta.changes) {
    const status: ChangeStatus = c.status === "deleted" ? "removed" : c.status === "added" ? "added" : "changed";
    const id = fileId(c.path);
    const n = byId.get(id);
    if (status === "removed" ? !wasIndexed(c.path) : !n) continue;
    direct.set(c.path, status);
    put({
      id,
      kind: "file",
      label: n?.label ?? basename(c.path),
      status,
      parent: n?.parent ?? removedParent(c.path),
      ...(c.linesAdded !== undefined ? { linesAdded: c.linesAdded } : {}),
      ...(c.linesDeleted !== undefined ? { linesDeleted: c.linesDeleted } : {}),
      ...(c.hunks.length ? { hunks: c.hunks.map((h) => [h.start, h.end] as [number, number]) } : {}),
      ...(c.oldPath !== undefined ? { oldPath: c.oldPath } : {}),
    });
  }

  // Blast radius: what depends on a changed file, and the importers of a removed one.
  const reach = new Map<string, number>();
  const touch = (rel: string, d: number) => {
    if (direct.has(rel)) return;
    const prev = reach.get(rel);
    if (prev === undefined || d < prev) reach.set(rel, d);
  };
  const closure = { skipInferred: true, goPackages: true };
  const seeds = [...direct].filter(([, s]) => s !== "removed").map(([rel]) => rel);
  for (const [rel, d] of codeindex.reverseClosure(graph.fileEdges, seeds, depth, closure)) touch(rel, d);
  const importers = [...new Set(delta.broken.map((b) => b.from))].sort(cmp);
  if (importers.length && depth >= 1) {
    for (const rel of importers) touch(rel, 1);
    for (const [rel, d] of codeindex.reverseClosure(graph.fileEdges, importers, depth - 1, closure)) touch(rel, d + 1);
  }
  for (const [rel, d] of reach) {
    const n = byId.get(fileId(rel));
    if (n) put({ id: n.id, kind: "file", label: n.label, status: "impacted", ...(n.parent ? { parent: n.parent } : {}), depth: d });
  }

  // --- symbols ---------------------------------------------------------------
  for (const c of delta.changes) {
    if (c.status === "deleted" || !direct.has(c.path)) continue;
    for (const s of c.symbols) {
      const n = byId.get(symId(c.path, s.parent ? s.parent.split("/")[0]! : s.name));
      if (n)
        put({ id: n.id, kind: "sym", label: n.label, status: c.status === "added" ? "added" : "changed", parent: n.parent, ...(n.at ? { at: n.at } : {}) });
    }
  }

  // --- facts -----------------------------------------------------------------
  if (direct.size) {
    // The raw diff's hunks: the delta's drop `approx` (a pure deletion's gap).
    const hunksOf = git.diff.hunks;
    const cur = factIndex(facts);
    let old: Map<string, FactRef> | undefined;
    if (direct.size > BASE_FACTS_MAX_FILES)
      notes.push(`${direct.size} changed files: base facts not re-extracted, removed routes / screens / entities / jobs are not reported`);
    else old = factIndex(baseFacts(repo, graph, delta, git.diff.base.mergeBase));
    // A fact owns its extent [line, end] (computed from the file when facts.json
    // predates extents). A hunk changes it when the two intersect on a line that
    // is neither blank nor comment-only; a pure deletion (`approx`, the gap after
    // its start line) when the gap falls inside the extent.
    const sources = new Map<string, { extent: ExtentOf; quiet: (from: number, to: number) => boolean } | undefined>();
    const sourceOf = (rel: string) => {
      if (!sources.has(rel)) {
        const text = readSource(join(repo, rel));
        sources.set(rel, text === undefined ? undefined : { extent: extentFinder(rel, text), quiet: blankOrCommentOnly(rel, text) });
      }
      return sources.get(rel);
    };
    const touched = (f: FactRef) => {
      const hunks = hunksOf.get(f.file) ?? [];
      if (!hunks.length) return false;
      const src = sourceOf(f.file);
      const end = Math.max(f.line, f.end ?? src?.extent(f.line) ?? f.line);
      return hunks.some((h) => {
        if (h.approx) return f.line <= h.start && h.start < end;
        const from = Math.max(h.start, f.line);
        const to = Math.min(h.end, end);
        return from <= to && !src?.quiet(from, to);
      });
    };
    for (const id of [...new Set([...cur.keys(), ...(old?.keys() ?? [])])].sort(cmp)) {
      const c = cur.get(id);
      const o = old?.get(id);
      const n = byId.get(id);
      if (c && n) {
        let status: ChangeStatus | undefined;
        if (old && !o) status = "added";
        else if (o && (o.sig !== c.sig || o.file !== c.file)) status = "changed";
        else if (direct.has(c.file) && touched(c)) status = !old && direct.get(c.file) === "added" ? "added" : "changed";
        else if (direct.has(c.file) || reach.has(c.file)) status = "impacted";
        if (status) put({ id, kind: c.kind, label: n.label, status, ...(n.parent ? { parent: n.parent } : {}), ...(n.at ? { at: n.at } : {}) });
      } else if (o && !c) {
        put({ id, kind: o.kind, label: o.label, status: "removed", parent: fileId(o.file), at: `${o.file}:${o.line}` });
      }
    }
  }

  // --- containers: module slices, systems, capabilities ------------------------
  const sysOf = (slice: string | undefined) => (slice ? (byId.get(slice)?.parent ?? goneContainers.get(slice)?.parent) : undefined);
  const capsOf = (file: ChangedNode) => byId.get(file.id)?.caps ?? (file.parent ? (byId.get(file.parent)?.caps ?? []) : []);
  const filesUnder = new Map<string, number>();
  for (const n of view.nodes) {
    if (n.kind !== "file") continue;
    for (const c of [n.parent, sysOf(n.parent), ...n.caps]) if (c) filesUnder.set(c, (filesUnder.get(c) ?? 0) + 1);
  }
  const agg = new Map<string, { changed: number; added: number; impacted: number }>();
  for (const f of nodes.values()) {
    if (f.kind !== "file") continue;
    for (const c of new Set([f.parent, sysOf(f.parent), ...capsOf(f)])) {
      if (!c) continue;
      const a = agg.get(c) ?? { changed: 0, added: 0, impacted: 0 };
      if (DIRECT.has(f.status)) a.changed++;
      if (f.status === "added") a.added++;
      if (f.status === "impacted") a.impacted++;
      agg.set(c, a);
    }
  }
  for (const [id, a] of agg) {
    const n: ViewNode | undefined = byId.get(id);
    const gone = goneContainers.get(id);
    const kind = id.slice(0, id.indexOf(":")) as ChangeNodeKind;
    let status: ChangeStatus;
    if (!n) status = "removed";
    else if (a.changed) status = a.added === a.changed && filesUnder.get(id) === a.added ? "added" : "changed";
    else status = "impacted";
    const label = n ? (n.slice ? `${n.label} ${n.slice.qualifier}` : n.label) : (gone?.label ?? id);
    const parent = n?.parent ?? gone?.parent ?? (parseSlice(id)?.system || undefined);
    put({ id, kind, label, status, ...(parent ? { parent } : {}), changedFiles: a.changed, impactedFiles: a.impacted });
  }

  // --- risk, broken imports, counts ------------------------------------------------
  const risk: ModuleRisk[] = delta.modules.map((m) => ({
    id: modId(m.slug),
    label: byId.get(modId(m.slug))?.label ?? humanizeSegment(m.path),
    path: m.path,
    score: m.score,
    bucket: m.bucket.toLowerCase() as RiskBucket,
    reasons: [...m.reasons],
    changedFiles: [...m.changedFiles],
    changedSymbols: { ...m.changedSymbols },
    impact: { directFiles: m.impact.directFiles, transitiveFiles: m.impact.transitiveFiles, modules: m.impact.modules.map(modId) },
    tests: { status: m.tests.status, files: [...m.tests.files] },
  }));
  const broken = delta.broken.map((b) => ({
    from: fileId(b.from),
    spec: b.spec,
    target: fileId(b.target),
    ...(b.renamedTo !== undefined ? { renamedTo: fileId(b.renamedTo) } : {}),
    kind: b.kind,
  }));
  const counts = Object.fromEntries(CHANGE_NODE_KINDS.map((k) => [k, zeroCounts()])) as Record<ChangeNodeKind, ChangeCounts>;
  for (const n of nodes.values()) counts[n.kind][n.status]++;

  const now = opts.now ?? new Date();
  const change: ChangeSet = {
    schema: CHANGE_SCHEMA,
    id: `${stampOf(now)}-${git.dirty || !git.head ? "worktree" : git.head.sha.slice(0, 7)}`,
    at: now.toISOString(),
    mode: git.mode,
    base: { ref: git.diff.base.ref, sha: git.diff.base.mergeBase },
    head: { ...(git.head ? { sha: git.head.sha } : {}), dirty: git.dirty },
    depth,
    counts,
    nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
    risk,
    broken,
    unindexed: delta.unindexed.filter((p) => !isOwn(p)),
    notes: [...delta.notes, ...notes],
    fingerprint: git.fingerprint,
  };
  return { change, view };
}

/** Would the index scan keep this path (the include / exclude globs it was built with)? */
function indexedPath(repo: string): (rel: string) => boolean {
  const scan = loadManifest(viewPaths(repo).index)?.scan;
  const include = codeindex.compileGlobs(scan?.include);
  const exclude = codeindex.compileGlobs(scan?.exclude);
  return (rel) => (!include || include(rel)) && !exclude?.(rel);
}

/** Read the git diff (unless given), refresh the map when it lags, and map the diff onto it. */
export async function computeDiff(repoArg: string, opts: DiffOptions = {}, read?: GitDiff): Promise<ComputedDiff> {
  const repo = resolve(repoArg);
  const git = read ?? readGitDiff(repo, opts);
  if (opts.refresh !== false && mapIsStale(repo)) await buildMap({ repo, ast: opts.ast });
  return changeSetOf(repo, git, opts);
}

/** The change set of the repository's current state (docs/design.md §6 `changes`). */
export async function diffMap(repo: string, opts: DiffOptions = {}): Promise<ChangeSet> {
  return (await computeDiff(repo, opts)).change;
}

// --- recording ---------------------------------------------------------------------

export interface RecordOptions {
  source?: TimelineSource;
  title?: string;
  /** Cited prose (one citation per sentence, every citation resolving); absent = an `auto` summary from the counts. */
  summary?: string;
  request?: string;
}

export interface RecordResult {
  ok: boolean;
  /** Repo-relative path of the change set written. */
  file?: string;
  entry?: TimelineEntry;
  errors: Problem[];
}

const directCount = (c: ChangeCounts) => c.added + c.changed + c.removed;

function labelsOf(change: ChangeSet, kind: ChangeNodeKind, direct: boolean): string[] {
  return change.nodes.filter((n) => n.kind === kind && DIRECT.has(n.status) === direct).map((n) => n.label);
}

const listWords = (xs: readonly string[], max = 8) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));

/** A title from the counts: `3 files changed in Checkout, Orders`. */
export function autoTitle(change: ChangeSet): string {
  const files = directCount(change.counts.file);
  const caps = labelsOf(change, "cap", true);
  return `${plural(files, "file")} changed${caps.length ? ` in ${listWords(caps, 3)}` : ""}`;
}

/** A summary from the counts (uncited by nature: recorded with `auto: true`). */
export function autoSummary(change: ChangeSet): string {
  const f = change.counts.file;
  const parts = [
    `${plural(directCount(f), "file")} changed (${f.added} added, ${f.changed} changed, ${f.removed} removed) and ${f.impacted} impacted within ${change.depth} hops.`,
  ];
  const caps = labelsOf(change, "cap", true);
  const impactedCaps = labelsOf(change, "cap", false);
  if (caps.length || impactedCaps.length)
    parts.push(
      `Capabilities: ${[caps.length ? `changed ${listWords(caps)}` : "", impactedCaps.length ? `impacted ${listWords(impactedCaps)}` : ""].filter(Boolean).join("; ")}.`,
    );
  const top = change.risk[0];
  if (top) parts.push(`Highest risk: ${top.label} (${top.bucket}, score ${top.score}).`);
  if (change.broken.length)
    parts.push(change.broken.length === 1 ? "1 import still points at a removed file." : `${change.broken.length} imports still point at removed files.`);
  return parts.join(" ");
}

const ITEM_ORDER: readonly ChangeNodeKind[] = ["cap", "sys", "mod", "route", "screen", "entity", "job", "file"];

/** The directly changed nodes of a change set as timeline items (no symbols, no impacted nodes), most general first. */
export function timelineItems(change: ChangeSet): TimelineItem[] {
  return change.nodes
    .filter((n) => DIRECT.has(n.status) && n.kind !== "sym")
    .sort((a, b) => ITEM_ORDER.indexOf(a.kind) - ITEM_ORDER.indexOf(b.kind) || cmp(a.id, b.id))
    .slice(0, TIMELINE_ITEMS_MAX)
    .map((n) => ({ ref: n.id, change: n.status === "added" ? "new" : n.status === "removed" ? "removed" : "changed" }));
}

/** Point view.json (when there is one) at the latest change set and the current timeline, without a rebuild. */
export function refreshViewChanges(repo: string): void {
  const abs = viewPaths(repo).view;
  if (!existsSync(abs)) return;
  let view: ViewModel;
  try {
    view = JSON.parse(readFileSync(abs, "utf8")) as ViewModel;
  } catch {
    return;
  }
  view.changes = latestChange(repo);
  view.timeline = timelineNewestFirst(readTimeline(repo));
  writeFileAtomic(abs, stableJson(view));
}

/**
 * Write `.ultraview/changes/<id>.json` and append its timeline entry (the
 * summary is validated first; nothing is written when it fails). An id already
 * taken (two records in one second) gets `-2`, `-3`, ….
 */
export function recordChange(repoArg: string, change: ChangeSet, opts: RecordOptions = {}): RecordResult {
  const repo = resolve(repoArg);
  if (opts.summary !== undefined) {
    const errors = summaryProblems(opts.summary, loadGraph(viewPaths(repo).index));
    if (errors.length) return { ok: false, errors };
  }
  const dir = join(repo, CHANGES_DIR);
  let id = change.id;
  for (let i = 2; existsSync(join(dir, `${id}.json`)); i++) id = `${change.id}-${i}`;
  const recorded: ChangeSet = { ...change, id };
  const entry: TimelineEntry = {
    at: recorded.at,
    source: opts.source ?? "manual",
    title: opts.title ?? autoTitle(recorded),
    ...(opts.request !== undefined ? { request: opts.request } : {}),
    summary: opts.summary ?? autoSummary(recorded),
    items: timelineItems(recorded),
    base: recorded.base.sha,
    ...(recorded.head.sha ? { head: recorded.head.sha } : {}),
    change: id,
    ...(opts.summary === undefined ? { auto: true } : {}),
  };
  const file = `${CHANGES_DIR}/${id}.json`;
  writeFileAtomic(join(repo, file), stableJson(recorded));
  const problems = appendTimeline(repo, entry);
  if (problems.length) return { ok: false, file, errors: problems };
  refreshViewChanges(repo);
  return { ok: true, file, entry, errors: [] };
}

/** Uncommitted / unrecorded work: the last recorded change set's mode, re-read now, differs from what it recorded. */
export function unrecordedChanges(repoArg: string): { last: string; mode: DiffMode } | undefined {
  const repo = resolve(repoArg);
  const last = latestChange(repo);
  if (!last) return undefined;
  try {
    const git = readGitDiff(repo, last.mode === "base" ? { base: last.base.ref } : { staged: last.mode === "staged", worktree: last.mode === "worktree" });
    if (!git.diff.files.length || git.fingerprint === last.fingerprint) return undefined;
    return { last: last.id, mode: last.mode };
  } catch {
    return undefined;
  }
}

// --- reporting -----------------------------------------------------------------------

const KIND_WORDS: [ChangeNodeKind, string][] = [
  ["cap", "Capabilities"],
  ["sys", "Systems"],
  ["route", "Routes"],
  ["screen", "Screens"],
  ["entity", "Data"],
  ["job", "Jobs"],
];

function byStatus(change: ChangeSet, kind: ChangeNodeKind, code: boolean): string {
  const fmt = (n: ChangedNode) => (code ? `\`${n.label}\`` : n.label);
  return (["added", "changed", "removed", "impacted"] as const)
    .map((s) => {
      const xs = change.nodes.filter((n) => n.kind === kind && n.status === s).map(fmt);
      return xs.length ? `${s} ${listWords(xs)}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const relOf = (id: string) => id.replace(/^file:/, "");

const STATUS_STYLE: Record<ChangeStatus, string> = {
  added: "fill:#d1fadf,stroke:#12b76a,color:#054f31",
  changed: "fill:#fef0c7,stroke:#f79009,color:#7a2e0e",
  removed: "fill:#fee4e2,stroke:#f04438,color:#7a271a,stroke-dasharray:4 2",
  impacted: "fill:#eff8ff,stroke:#2e90fa,color:#194185",
};

/** The impacted subgraph at module level (system level past MERMAID_MAX_NODES modules), as a Mermaid flowchart. */
export function changeMermaid(change: ChangeSet, view: ViewModel): string {
  const mods = change.nodes.filter((n) => n.kind === "mod");
  const level: ChangeNodeKind = mods.length && mods.length <= MERMAID_MAX_NODES ? "mod" : "sys";
  const riskOf = new Map(change.risk.map((r) => [r.id, r]));
  const picked = change.nodes
    .filter((n) => n.kind === level)
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        (riskOf.get(parseSlice(b.id)?.of ?? b.id)?.score ?? 0) - (riskOf.get(parseSlice(a.id)?.of ?? a.id)?.score ?? 0) ||
        cmp(a.id, b.id),
    )
    .slice(0, MERMAID_MAX_NODES);
  const keep = new Set(picked.map((n) => n.id));
  const pairs = new Map<string, PickedEdge & { weight: number }>();
  for (const e of view.edges) {
    if (e.from === e.to || !keep.has(e.from) || !keep.has(e.to)) continue;
    const key = `${e.from}\n${e.to}`;
    const p = pairs.get(key) ?? { from: e.from, to: e.to, weight: 0 };
    p.weight += e.weight;
    pairs.set(key, p);
  }
  const edges = [...pairs.values()].sort((a, b) => b.weight - a.weight || cmp(a.from, b.from) || cmp(a.to, b.to)).slice(0, MERMAID_MAX_EDGES);
  return mermaidFlowchart(
    {
      nodes: picked.map((n) => {
        const r = level === "mod" ? riskOf.get(parseSlice(n.id)?.of ?? n.id) : undefined;
        return { id: n.id, label: `${n.label}${r ? ` · ${r.bucket} risk` : ""}`, kind: n.kind, cls: n.status };
      }),
      edges: edges.map(({ from, to }) => ({ from, to })),
    },
    { classes: STATUS_STYLE },
  );
}

const baseWords = (change: ChangeSet) =>
  `${change.mode === "staged" ? "staged changes" : change.mode === "worktree" ? "uncommitted changes" : "changes"} against \`${change.base.ref}\` (\`${change.base.sha.slice(0, 7)}\`)${change.mode === "base" && change.head.dirty ? ", uncommitted work included" : ""}`;

/** A PR-ready Markdown summary: headline counts, what it touches in plain words, risk, broken imports, the impacted subgraph. */
export function changeMarkdown(change: ChangeSet, view: ViewModel): string {
  const f = change.counts.file;
  const out = [
    "## Change summary",
    "",
    `**${plural(directCount(f), "file")} changed** (${f.added} added, ${f.changed} changed, ${f.removed} removed) and **${f.impacted} impacted** within ${change.depth} hops: ${baseWords(change)}.`,
    "",
  ];
  const touches = KIND_WORDS.map(([k, words]) => [words, byStatus(change, k, k !== "cap" && k !== "sys")] as const).filter(([, s]) => s);
  out.push("### What it touches", "");
  if (touches.length) for (const [words, s] of touches) out.push(`- **${words}**: ${s}.`);
  else out.push("- Nothing on the map beyond the files themselves.");
  out.push("");
  if (change.risk.length) {
    out.push("### Risk", "", "| Module | Risk | Score | Tests | Why |", "|---|---|---|---|---|");
    for (const r of change.risk) {
      out.push(`| ${cell(r.label)} (\`${cell(r.path)}\`) | ${r.bucket} | ${r.score} | ${r.tests.status} | ${cell(r.reasons.join("; ") || "—")} |`);
    }
    out.push("");
  }
  if (change.broken.length) {
    out.push("### Broken imports", "");
    for (const b of change.broken) {
      out.push(
        `- \`${relOf(b.from)}\` still imports \`${b.spec}\`, which was \`${relOf(b.target)}\` (${b.renamedTo ? `renamed to \`${relOf(b.renamedTo)}\`` : "removed"}).`,
      );
    }
    out.push("");
  }
  if (change.nodes.some((n) => n.kind === "mod" || n.kind === "sys")) {
    out.push("### Impacted map", "", "```mermaid", changeMermaid(change, view).trimEnd(), "```", "");
  }
  if (change.unindexed.length) {
    out.push(
      "### Not on the map",
      "",
      `- ${plural(change.unindexed.length, "changed file")} outside the index: ${listWords(
        change.unindexed.map((p) => `\`${p}\``),
        10,
      )}.`,
      "",
    );
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Plain-text report for the agent. */
export function formatChange(change: ChangeSet): string {
  const f = change.counts.file;
  const lines = [
    `diff       ${baseWords(change).replace(/`/g, "")}: ${plural(directCount(f), "file")} changed (${f.added} added, ${f.changed} changed, ${f.removed} removed), ${f.impacted} impacted (depth ${change.depth})`,
  ];
  for (const [k, words] of [
    ["cap", "capabilities"],
    ["sys", "systems"],
    ["mod", "modules"],
    ["route", "routes"],
    ["screen", "screens"],
    ["entity", "entities"],
    ["job", "jobs"],
  ] as const) {
    const s = byStatus(change, k, false);
    if (s) lines.push(`${words.padEnd(13)}${s}`);
  }
  if (change.risk.length) {
    lines.push("risk");
    for (const r of change.risk)
      lines.push(`  ${r.bucket.toUpperCase().padEnd(7)}${r.id}  score ${r.score}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}`);
  }
  for (const b of change.broken)
    lines.push(`broken     ${relOf(b.from)} imports ${b.spec} → ${relOf(b.target)} (${b.renamedTo ? `renamed to ${relOf(b.renamedTo)}` : "removed"})`);
  if (change.unindexed.length) lines.push(`unindexed  ${listWords(change.unindexed, 10)}`);
  for (const n of change.notes) lines.push(`note       ${n}`);
  return `${lines.join("\n")}\n`;
}
