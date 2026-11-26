// `ultraview lens save <file>` / `flow save <file>`, as library calls
// (docs/design.md §4): validate what the agent wrote, stamp `sources` (the
// sha256 of every cited file, so `check` can tell when the answer went stale),
// and write it byte-stable under .ultraview/.
//
// `sources` is never trusted from the input: it is recomputed on every save.
// Saving a DIFFERENT question (lens) or title (flow) under an existing id is
// refused unless `force` — an id is a deep link (`#lens=<id>`) someone may hold.
//
// Before a lens's gates, the node ids it names are repaired (src/gates.ts
// `repairAnswerIds`: `src-diff` → `mod:src-diff` when exactly one node id
// fits); every repair is reported in the result's `repairs`. A lens and a
// conversation turn (`prepareLens`) share this one place.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { checkCitations, fileLineTable, loadGraph, parseCitations } from "./engine.js";
import { type IdRepair, repairAnswerIds } from "./gates.js";
import { stableJson } from "./json.js";
import { FLOWS_DIR, fileSha256, LENSES_DIR } from "./model/load.js";
import type { Flow, Lens, SourceHashes } from "./model/types.js";
import { type Problem, parseJson, validateFlow, validateLens } from "./model/validate.js";
import { viewPaths } from "./paths.js";
import { liveView } from "./show.js";

export interface SaveOptions {
  /** Overwrite a different question / title saved under the same id. */
  force?: boolean;
}

export interface SaveResult {
  ok: boolean;
  /** Repo-relative path written (or that would have been). */
  file?: string;
  id?: string;
  sources: SourceHashes;
  /** Whether an existing file was replaced. */
  replaced: boolean;
  /** Node ids rewritten before the gates (repairAnswerIds), saved or not. */
  repairs: IdRepair[];
  errors: Problem[];
}

/** The view's node ids, read when a repair needs them. */
export type NodeIds = () => ReadonlySet<string>;

interface Kind<T> {
  dir: string;
  validate: (v: unknown) => Problem[];
  /** Every cited prose string, with its location. */
  prose: (item: T) => { path: string; text: string }[];
  /** What makes two saves "the same view" (lens question, flow title). */
  identity: (item: T) => string;
  noun: string;
  /** Repair the node ids it names before the gates (a lens). */
  repair: boolean;
}

const LENS: Kind<Lens> = {
  dir: LENSES_DIR,
  validate: validateLens,
  prose: (l) => [{ path: "answer", text: l.answer }],
  identity: (l) => l.question,
  noun: "question",
  repair: true,
};

const FLOW: Kind<Flow> = {
  dir: FLOWS_DIR,
  validate: validateFlow,
  prose: (f) => f.steps.map((s, i) => ({ path: `steps[${i}].note`, text: s.note })),
  identity: (f) => f.title,
  noun: "title",
  repair: false,
};

/** What `prepare` found: the parsed item and its stamped sources, or the problems. */
export interface Prepared<T> {
  item?: T;
  sources: SourceHashes;
  /** Node ids rewritten before the gates. */
  repairs: IdRepair[];
  errors: Problem[];
}

/** The node ids of the live view of `repo` (assembled once, on first use; none when there is no map to read). */
function liveIds(repo: string): NodeIds {
  let ids: ReadonlySet<string> | undefined;
  return () => {
    if (ids) return ids;
    try {
      ids = new Set(liveView(repo).byId.keys());
    } catch {
      ids = new Set();
    }
    return ids;
  };
}

/**
 * The gates before a write: the node ids repaired (a lens: `ids`, the view's
 * node ids, read only when a repair needs them), the schema, then every
 * citation of every prose string — each cited file must exist inside the repo
 * and, with an index, every citation must resolve. Returns the `sources` to
 * stamp (the sha256 of each cited file). Writes nothing.
 */
function prepare<T>(kind: Pick<Kind<T>, "validate" | "prose" | "repair">, repo: string, input: unknown, ids: NodeIds = liveIds(repo)): Prepared<T> {
  let value = input;
  if (typeof input === "string") {
    const parsed = parseJson(input);
    if (parsed.problems.length) return { sources: {}, repairs: [], errors: parsed.problems };
    value = parsed.value;
  }
  let repairs: IdRepair[] = [];
  if (kind.repair) ({ value, repairs } = repairAnswerIds(value, ids));
  const schemaErrors = kind.validate(value);
  if (schemaErrors.length) return { sources: {}, repairs, errors: schemaErrors };
  const item = value as T;

  const errors: Problem[] = [];
  const graph = loadGraph(viewPaths(repo).index);
  const lineTable = graph ? fileLineTable(graph) : undefined;
  const cited = new Set<string>();
  for (const { path, text } of kind.prose(item)) {
    if (lineTable) for (const u of checkCitations(text, lineTable).unresolved) errors.push({ path, message: `dead citation [${u.citation.raw}]: ${u.reason}` });
    for (const c of parseCitations(text)) {
      const abs = resolve(repo, c.path);
      const inside = abs.startsWith(repo + sep);
      if (!inside || !existsSync(abs) || !statSync(abs).isFile()) {
        if (inside && !c.path.includes("/") && !existsSync(abs)) continue; // not a path after all ([Node.js]): the engine ignores it too
        errors.push({ path, message: `cites ${c.path}, which is not a file in the repo` });
        continue;
      }
      cited.add(relative(repo, abs).split(sep).join("/"));
    }
  }
  if (errors.length) return { item, sources: {}, repairs, errors };
  const sources: SourceHashes = {};
  for (const rel of [...cited].sort()) sources[rel] = fileSha256(join(repo, rel))!;
  return { item, sources, repairs, errors: [] };
}

/**
 * `lens save`'s gates without the write (schema, citations, `sources`), for
 * answers stored elsewhere: a conversation turn (src/chat.ts) is a lens
 * answer and passes exactly these, its node ids repaired against `ids`
 * (default: the live view's).
 */
export function prepareLens(repoArg: string, input: unknown, ids?: NodeIds): Prepared<Lens> {
  const repo = resolve(repoArg);
  return prepare(LENS, repo, input, ids ?? liveIds(repo));
}

function save<T extends { id: string; sources?: SourceHashes }>(kind: Kind<T>, repoArg: string, input: unknown, opts: SaveOptions): SaveResult {
  const repo = resolve(repoArg);
  const prepared = prepare(kind, repo, input);
  const { repairs } = prepared;
  const fail = (errors: Problem[], extra: Partial<SaveResult> = {}): SaveResult => ({ ok: false, sources: {}, replaced: false, repairs, errors, ...extra });

  const item = prepared.item;
  if (!item) return fail(prepared.errors);
  const file = `${kind.dir}/${item.id}.json`;
  if (prepared.errors.length) return fail(prepared.errors, { file, id: item.id });
  const sources = prepared.sources;

  const abs = join(repo, file);
  let replaced = false;
  if (existsSync(abs)) {
    const prev = parseJson(readFileSync(abs, "utf8")).value as Partial<T> | undefined;
    const prevIdentity = prev && kind.validate(prev).length === 0 ? kind.identity(prev as T) : undefined;
    if (prevIdentity !== undefined && prevIdentity !== kind.identity(item) && !opts.force) {
      return fail(
        [{ path: "id", message: `${file} already holds a different ${kind.noun} ("${prevIdentity}"): pick another id, or pass --force to replace it` }],
        { file, id: item.id },
      );
    }
    replaced = true;
  }

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, stableJson({ ...item, sources }));
  return { ok: true, file, id: item.id, sources, replaced, repairs, errors: [] };
}

/** Validate a lens (JSON text or object), stamp its `sources`, write `.ultraview/lenses/<id>.json`. */
export function saveLens(repo: string, input: unknown, opts: SaveOptions = {}): SaveResult {
  return save(LENS, repo, input, opts);
}

/** Validate a flow (JSON text or object), stamp its `sources`, write `.ultraview/flows/<id>.json`. */
export function saveFlow(repo: string, input: unknown, opts: SaveOptions = {}): SaveResult {
  return save(FLOW, repo, input, opts);
}
