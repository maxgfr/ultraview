// The gates a saved answer passes (docs/design.md §7), shared by `check`
// (lenses, conversation turns) and `lens save --thread` (src/chat.ts), so a
// turn is refused at save time by the very rules `check` applies later; and
// the one repair made before them (repairAnswerIds), shared by `lens save`,
// `lens save --thread` and the Ask bridge.

import { checkCitations, type fileLineTable } from "./engine.js";
import { isNodeId } from "./model/ids.js";
import { uncitedSentences } from "./model/prose.js";
import { EDGE_KIND_MEANINGS, EDGE_KINDS, NODE_KINDS, type ViewEdgeKind } from "./model/types.js";
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

/**
 * One change made before the gates: a value rewritten (`to`: a node id given
 * its prefix, an edge kind given its canonical name), or a key or a whole edge
 * dropped (`dropped`: why). `from` is what the reply held (for a drop, the
 * dropped value as written); `path` is its place in the reply as written.
 */
export interface Repair {
  path: string;
  from: unknown;
  to?: string;
  dropped?: string;
}

/**
 * The node id of the view that `value` stands for, when exactly one fits:
 * `<kind>:<value>` for some node kind (`src-diff` → `mod:src-diff`,
 * `Order` → `entity:Order`), or `file:<value>` for a repo-relative path, a
 * leading `./` dropped (`./src/x.ts` → `file:src/x.ts`). Undefined when
 * `value` is already a node id of the view, when none fits, or when several
 * do: no other guess is made.
 */
export function repairNodeId(value: string, ids: ReadonlySet<string>): string | undefined {
  if (ids.has(value)) return undefined;
  const fits = new Set<string>();
  for (const kind of NODE_KINDS) if (ids.has(`${kind}:${value}`)) fits.add(`${kind}:${value}`);
  const path = value.startsWith("./") ? value.slice(2) : value;
  if (path && ids.has(`file:${path}`)) fits.add(`file:${path}`);
  return fits.size === 1 ? [...fits][0] : undefined;
}

/**
 * Edge kinds an agent writes for exactly one kind of the view-model (keys
 * normalised: lower case, spaces and underscores as dashes). Words that could
 * mean several kinds are left out on purpose, so an edge using one is dropped
 * rather than guessed: `uses` / `depends-on` (import, call or data), `api`
 * (http or rpc), `triggers` / `sends` / `dispatches` (event, queue, call or
 * http), `query` (data, or an HTTP / GraphQL query), `requires` (an import, or
 * a precondition), `has` / `owns` (contains, or a data relation), `schedules`
 * (a queued job, or a cron one), `link` / `related` (no kind at all).
 */
export const EDGE_KIND_SYNONYMS: Readonly<Record<string, ViewEdgeKind>> = {
  imports: "import",
  imported: "import",
  calls: "call",
  called: "call",
  invoke: "call",
  invokes: "call",
  invocation: "call",
  request: "http",
  requests: "http",
  fetch: "http",
  fetches: "http",
  rest: "http",
  "http-call": "http",
  "http-request": "http",
  trpc: "rpc",
  procedure: "rpc",
  "server-action": "rpc",
  read: "data",
  reads: "data",
  write: "data",
  writes: "data",
  "reads-from": "data",
  "writes-to": "data",
  "read-write": "data",
  "reads-writes": "data",
  store: "data",
  stores: "data",
  persists: "data",
  db: "data",
  database: "data",
  emit: "event",
  emits: "event",
  publish: "event",
  publishes: "event",
  subscribe: "event",
  subscribes: "event",
  listens: "event",
  "listens-to": "event",
  events: "event",
  enqueue: "queue",
  enqueues: "queue",
  job: "queue",
  jobs: "queue",
  queues: "queue",
  extend: "extends",
  inherits: "extends",
  implements: "extends",
  subclass: "extends",
  configures: "config",
  configuration: "config",
  env: "config",
  contain: "contains",
  include: "contains",
  includes: "contains",
};

/** The edge kind `value` names: itself, in any case, or its one synonym (EDGE_KIND_SYNONYMS); undefined when none. */
export function repairEdgeKind(value: string): ViewEdgeKind | undefined {
  const norm = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if ((EDGE_KINDS as readonly string[]).includes(norm)) return norm as ViewEdgeKind;
  return Object.hasOwn(EDGE_KIND_SYNONYMS, norm) ? EDGE_KIND_SYNONYMS[norm] : undefined;
}

/** The keys an answer's edge may carry. */
const EDGE_KEYS = ["from", "to", "kind"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * An answer (a lens, a turn) repaired before the gates, and the list of what
 * was changed. The input is never mutated; when nothing changes, the very
 * input comes back. Anything that is not the expected shape is left to the
 * schema, which still refuses an answer whose required fields are invalid.
 *
 * 1. Node ids (`nodes`, each edge's `from` / `to`, `focus`) by `repairNodeId`.
 *    Only a value that is not a well-formed node id is looked at (a
 *    well-formed one that names no node fails the gates as it is).
 * 2. Edges, optional decoration of the answer (its cited prose and nodes are
 *    the answer): on each, a key other than `from`, `to`, `kind` is dropped
 *    (`label`, `cite`…); a `kind` that is not an edge kind is rewritten when
 *    it names exactly one (`repairEdgeKind`: `calls` → `call`, `reads` →
 *    `data`); and the edge is dropped, with the reason, when its kind still
 *    is not one, or an end is missing, is not a node id, or (given the map's
 *    ids) names no node. A dropped edge is reported once, as written.
 *
 * `ids` (the view's node ids; empty when there is no map, and then an edge's
 * ends are only checked for form) is read only when a node id needs a repair
 * or there are edges to check.
 */
export function repairAnswer<T>(value: T, ids: () => ReadonlySet<string>): { value: T; repairs: Repair[] } {
  if (!isRecord(value)) return { value, repairs: [] };
  const rec = value;
  const loose = (v: unknown): v is string => typeof v === "string" && !isNodeId(v);
  const edges = Array.isArray(rec.edges) ? rec.edges : undefined;
  const any = (Array.isArray(rec.nodes) && rec.nodes.some(loose)) || (edges?.length ?? 0) > 0 || loose(rec.focus);
  if (!any) return { value, repairs: [] };

  let known: ReadonlySet<string> | undefined;
  const view = () => {
    known ??= ids();
    return known;
  };
  const repairs: Repair[] = [];
  const fix = (path: string, v: unknown, into: Repair[]): unknown => {
    if (!loose(v)) return v;
    const to = repairNodeId(v, view());
    if (to === undefined) return v;
    into.push({ path, from: v, to });
    return to;
  };
  const out: Record<string, unknown> = { ...rec };
  if (Array.isArray(rec.nodes)) out.nodes = rec.nodes.map((n, i) => fix(`nodes[${i}]`, n, repairs));
  if (edges) {
    const kept: unknown[] = [];
    edges.forEach((e, i) => {
      const at = `edges[${i}]`;
      const r = repairEdge(e, at, view, fix);
      if (r.edge === undefined) repairs.push({ path: at, from: e, dropped: r.reasons.join("; ") });
      else {
        repairs.push(...r.repairs);
        kept.push(r.edge);
      }
    });
    out.edges = kept;
  }
  if ("focus" in rec) out.focus = fix("focus", rec.focus, repairs);
  // Every change is reported: none means the very input comes back.
  return repairs.length ? { value: out as T, repairs } : { value, repairs: [] };
}

/** One edge repaired (repairAnswer step 2): the edge to keep, with what was changed on it, or none and why. */
function repairEdge(
  e: unknown,
  at: string,
  view: () => ReadonlySet<string>,
  fix: (path: string, v: unknown, into: Repair[]) => unknown,
): { edge?: Record<string, unknown>; repairs: Repair[]; reasons: string[] } {
  if (!isRecord(e))
    return { repairs: [], reasons: [`an edge is an object {"from", "to", "kind"} (got ${e === null ? "null" : Array.isArray(e) ? "an array" : typeof e})`] };
  const repairs: Repair[] = [];
  const reasons: string[] = [];
  const edge: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(e)) {
    if (!(EDGE_KEYS as readonly string[]).includes(key))
      repairs.push({ path: `${at}.${key}`, from: v, dropped: `not an edge key (an edge holds ${EDGE_KEYS.join(", ")})` });
  }
  for (const end of ["from", "to"] as const) {
    if (!(end in e)) {
      reasons.push(`no "${end}"`);
      continue;
    }
    const v = fix(`${at}.${end}`, e[end], repairs);
    edge[end] = v;
    if (typeof v !== "string" || !isNodeId(v)) reasons.push(`"${end}" ${JSON.stringify(v)} is not a node id`);
    else if (view().size && !view().has(v)) reasons.push(`"${end}" ${JSON.stringify(v)} names no node of the map`);
  }
  if ("kind" in e) {
    const kind = typeof e.kind === "string" ? repairEdgeKind(e.kind) : undefined;
    if (kind === undefined) reasons.push(`kind ${JSON.stringify(e.kind)} is not an edge kind (${EDGE_KINDS.join(", ")})`);
    else {
      if (kind !== e.kind) repairs.push({ path: `${at}.kind`, from: e.kind, to: kind });
      edge.kind = kind;
    }
  }
  return reasons.length ? { repairs: [], reasons } : { edge, repairs, reasons };
}

/** Whether a repair is of `edges[i]` as a whole, `edges[i].kind`, another edge key, or a node id. */
function repairKind(r: Repair): "edge" | "edge kind" | "edge key" | "node id" {
  if (/^edges\[\d+\]$/.test(r.path)) return "edge";
  if (r.dropped !== undefined) return "edge key";
  return /^edges\[\d+\]\.kind$/.test(r.path) ? "edge kind" : "node id";
}

/**
 * The heading of a repair list: `repaired 8 node id(s)`, `repaired 1 edge
 * kind(s); dropped 1 edge key(s), 1 edge(s)`, `dropped 1 edge(s)`. With
 * `pad`, the verb is padded like the CLI's other headings (`repaired   `).
 */
export function repairHeading(repairs: readonly Repair[], pad = false): string {
  const count = (k: ReturnType<typeof repairKind>) => repairs.filter((r) => repairKind(r) === k).length;
  const part = (k: ReturnType<typeof repairKind>) => (count(k) ? [`${count(k)} ${k}(s)`] : []);
  const fixed = [...part("node id"), ...part("edge kind")];
  const dropped = [...part("edge key"), ...part("edge")];
  const verb = (v: string) => (pad ? v.padEnd(11) : `${v} `);
  return [
    ...(fixed.length ? [`${verb("repaired")}${fixed.join(", ")}`] : []),
    ...(dropped.length ? [`${fixed.length ? "dropped " : verb("dropped")}${dropped.join(", ")}`] : []),
  ].join("; ");
}

/** The lines saying what was repaired or dropped (`  nodes[0]: "src-diff" -> "mod:src-diff"`, `  edges[1]: dropped {…} (why)`). */
export const repairLines = (repairs: readonly Repair[], indent = "  "): string[] =>
  repairs.map((r) =>
    r.dropped !== undefined
      ? `${indent}${r.path}: dropped ${JSON.stringify(r.from) ?? "undefined"} (${r.dropped})`
      : `${indent}${r.path}: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`,
  );

/**
 * The prompt lines that state the edge shape `repairAnswer` expects, and the
 * edge kinds with their meaning: those of `around` (the view edges around a
 * pack's candidates) first, then the others by name, with one of `around` as
 * the example (the first between two nodes finer than a capability or a
 * system, else the first); every kind with its meaning when `around` is empty.
 */
export function edgeRule(around: readonly { from: string; to: string; kind: ViewEdgeKind }[] = []): string[] {
  const here = EDGE_KINDS.filter((k) => around.some((e) => e.kind === k));
  const others = EDGE_KINDS.filter((k) => !here.includes(k));
  const mean = (ks: readonly ViewEdgeKind[]) => ks.map((k) => `${k} (${EDGE_KIND_MEANINGS[k]})`).join("; ");
  const coarse = (id: string) => id.startsWith("cap:") || id.startsWith("sys:");
  const example = around.find((e) => !coarse(e.from) && !coarse(e.to)) ?? around[0];
  return [
    'Each edge is exactly {"from": "<node id>", "to": "<node id>", "kind": "<edge kind>"}: kind optional, no other key (no label); edges may be [].',
    here.length
      ? `Edge kinds around these candidates: ${mean(here)}.${others.length ? ` The other edge kinds: ${others.join(", ")}.` : ""}`
      : `Edge kinds: ${mean(EDGE_KINDS)}.`,
    ...(example ? [`e.g. {"from": ${JSON.stringify(example.from)}, "to": ${JSON.stringify(example.to)}, "kind": ${JSON.stringify(example.kind)}}`] : []),
    "Any other key is dropped; an edge with another kind, or an end that is not a node of the map, is dropped.",
  ];
}
