// `.ultraview/timeline.jsonl` (docs/design.md §1, §7): one stable-JSON object
// per line, APPEND ONLY. A line is validated before it is written and refused
// when it fails; the file is never rewritten. `timeline add` writes a narrated
// entry (agent task, PR, manual note); `diff --record` writes one per change set.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkCitations, fileLineTable, type Graph, loadGraph } from "./engine.js";
import { stableLine } from "./json.js";
import { assembleView } from "./model/assemble.js";
import { loadViewInputs, TIMELINE_FILE } from "./model/load.js";
import { uncitedSentences } from "./model/prose.js";
import type { ChangeKind, TimelineEntry, TimelineItem, TimelineSource } from "./model/types.js";
import { type Problem, parseJson, validateTimelineEntry } from "./model/validate.js";
import { viewPaths } from "./paths.js";

/** Cited-prose problems of `text`: dead citations (against the index's line table, when there is one) and uncited sentences. */
export function summaryProblems(text: string, graph: Graph | undefined, path = "summary"): Problem[] {
  const out: Problem[] = [];
  if (graph)
    for (const u of checkCitations(text, fileLineTable(graph)).unresolved) out.push({ path, message: `dead citation [${u.citation.raw}]: ${u.reason}` });
  for (const s of uncitedSentences(text)) out.push({ path, message: `uncited sentence: "${s.length > 120 ? `${s.slice(0, 117)}...` : s}"` });
  return out;
}

function endsWithNewline(abs: string): boolean {
  const size = statSync(abs).size;
  if (size === 0) return true;
  const fd = openSync(abs, "r");
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one entry to `.ultraview/timeline.jsonl`. Validated first: a failing
 * entry is refused (its problems returned, nothing written). Never rewrites the
 * file; a missing final newline is completed before the new line.
 */
export function appendTimeline(repo: string, entry: TimelineEntry): Problem[] {
  const problems = validateTimelineEntry(entry);
  if (problems.length) return problems;
  const abs = viewPaths(resolve(repo)).timeline;
  mkdirSync(dirname(abs), { recursive: true });
  const lead = existsSync(abs) && !endsWithNewline(abs) ? "\n" : "";
  appendFileSync(abs, lead + stableLine(entry));
  return [];
}

/** `--items <json>`: a JSON array of `{ ref, change, note? }`. */
export function parseItems(text: string): { items: TimelineItem[]; problems: Problem[] } {
  const { value, problems } = parseJson(text);
  if (problems.length) return { items: [], problems: problems.map((p) => ({ path: "items", message: p.message })) };
  if (!Array.isArray(value)) return { items: [], problems: [{ path: "items", message: "must be a JSON array of { ref, change, note? }" }] };
  return { items: value as TimelineItem[], problems: [] };
}

/** Repeated `--ref <id> [--change new|changed|removed] [--note …]`, in command-line order: each `--ref` opens an item. */
export function itemsFromFlags(seq: readonly (readonly [string, string])[]): { items: TimelineItem[]; problems: Problem[] } {
  const items: TimelineItem[] = [];
  const problems: Problem[] = [];
  for (const [key, value] of seq) {
    if (key === "ref") {
      items.push({ ref: value, change: "changed" });
      continue;
    }
    if (key !== "change" && key !== "note") continue;
    const last = items[items.length - 1];
    if (!last) {
      problems.push({ path: `--${key}`, message: `--${key} must follow a --ref` });
      continue;
    }
    if (key === "change") last.change = value as ChangeKind;
    else last.note = value;
  }
  return { items, problems };
}

export interface TimelineAddInput {
  title: string;
  summary: string;
  request?: string;
  source?: TimelineSource;
  items?: TimelineItem[];
}

export interface TimelineAddResult {
  ok: boolean;
  /** Repo-relative file appended to. */
  file: string;
  entry?: TimelineEntry;
  errors: Problem[];
}

/**
 * `timeline add`: validate an entry (schema, cited summary, item ids that
 * resolve in the current map — a `removed` item may name a node that is gone),
 * then append it. `now` stamps `at` (default: the current time).
 */
export function addTimelineEntry(repoArg: string, input: TimelineAddInput, now: Date = new Date()): TimelineAddResult {
  const repo = resolve(repoArg);
  if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`);
  const entry: TimelineEntry = {
    at: now.toISOString(),
    source: input.source ?? "agent",
    title: input.title,
    ...(input.request !== undefined ? { request: input.request } : {}),
    summary: input.summary,
    items: input.items ?? [],
  };
  const fail = (errors: Problem[]): TimelineAddResult => ({ ok: false, file: TIMELINE_FILE, errors });
  const schema = validateTimelineEntry(entry);
  if (schema.length) return fail(schema);

  const graph = loadGraph(viewPaths(repo).index);
  const errors = summaryProblems(entry.summary, graph);
  if (graph) {
    const ids = new Set(assembleView(loadViewInputs(repo, { graph }).inputs).nodes.map((n) => n.id));
    entry.items.forEach((it, i) => {
      if (!ids.has(it.ref) && it.change !== "removed")
        errors.push({ path: `items[${i}].ref`, message: `unknown node "${it.ref}" (only a removed item may name a node that is gone)` });
    });
  }
  if (errors.length) return fail(errors);
  const problems = appendTimeline(repo, entry);
  if (problems.length) return fail(problems);
  return { ok: true, file: TIMELINE_FILE, entry, errors: [] };
}
