// The shapes ultraview reads and writes (docs/design.md §3, §4, §6):
//
//   model.json        agent-authored: app, systems, capabilities, edges, tour, glossary
//   flows/<id>.json   agent-authored: a cited walk through the map
//   lenses/<id>.json  agent-authored: one saved question and its cited answer
//   timeline.jsonl    appended: one entry per agent task / PR / manual note
//   view.json         generated: the merged view-model the viewer draws
//
// Type-only apart from the enum tables, so the viewer bundle can import it
// without pulling anything else in.

export const MODEL_SCHEMA = 1;
export const VIEW_SCHEMA = 1;

/** What a system is (model.json `systems[].kind`). */
export const SYSTEM_KINDS = ["ui", "service", "worker", "library", "data", "external", "infra", "script", "test", "config"] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

/** Who the viewer opens for by default (model.json `app.audience`). */
export const AUDIENCES = ["everyone", "developers"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Every node kind of the view-model; the id prefix of a node is its kind (`cap:checkout`). */
export const NODE_KINDS = ["cap", "sys", "mod", "file", "sym", "route", "screen", "entity", "job", "ext", "infra"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Every edge kind of the view-model. `contains` is never derived (the tree is `parent`); a model or lens edge may use it. */
export const EDGE_KINDS = ["import", "call", "http", "data", "event", "queue", "extends", "config", "contains"] as const;
export type ViewEdgeKind = (typeof EDGE_KINDS)[number];

export const TIMELINE_SOURCES = ["agent", "pr", "manual"] as const;
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

export const CHANGE_KINDS = ["new", "changed", "removed"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

// ---------------------------------------------------------------------------
// model.json

export interface ModelApp {
  name: string;
  /** Cited prose. */
  summary?: string;
  audience?: Audience;
}

export interface ModelSystem {
  /** Bare slug; the node id is `sys:<id>`. */
  id: string;
  label: string;
  kind: SystemKind;
  summary?: string;
  /** Globs over repo-relative paths; the most specific match wins a file. */
  paths: string[];
  exclude?: string[];
}

export interface ModelCapability {
  /** Bare slug; the node id is `cap:<id>`. */
  id: string;
  label: string;
  summary?: string;
  actors?: string[];
  /** Node ids (`mod:…`, `route:…`, `entity:…`, …). */
  members?: string[];
  /** Globs over repo-relative paths: matching files are members too. */
  paths?: string[];
  tags?: string[];
}

/** A relation the engine cannot see (queues, events, webhooks, cron, cross-repo). */
export interface ModelEdge {
  from: string;
  to: string;
  kind: ViewEdgeKind;
  label?: string;
  /** `path:line` the relation rests on. */
  cite?: string;
}

export interface TourStop {
  node: string;
  note: string;
}

export interface GlossaryEntry {
  term: string;
  meaning: string;
}

export interface Model {
  schema: typeof MODEL_SCHEMA;
  app: ModelApp;
  systems: ModelSystem[];
  capabilities: ModelCapability[];
  edges?: ModelEdge[];
  tour?: TourStop[];
  glossary?: GlossaryEntry[];
}

// ---------------------------------------------------------------------------
// flows/<id>.json and lenses/<id>.json

/** Repo-relative path → sha256 (hex) of the file's bytes when the flow / lens was saved. */
export type SourceHashes = Record<string, string>;

export interface FlowStep {
  node: string;
  note: string;
}

export interface Flow {
  schema: typeof MODEL_SCHEMA;
  id: string;
  title: string;
  trigger?: string;
  steps: FlowStep[];
  /** Stamped by `flow save`, never written by the model. */
  sources?: SourceHashes;
}

export interface LensEdge {
  from: string;
  to: string;
  kind?: ViewEdgeKind;
}

export interface Lens {
  schema: typeof MODEL_SCHEMA;
  id: string;
  question: string;
  /** Markdown; every sentence cites `[path:line]`. */
  answer: string;
  nodes: string[];
  edges?: LensEdge[];
  focus?: string;
  /** Stamped by `lens save`, never written by the model. */
  sources?: SourceHashes;
}

// ---------------------------------------------------------------------------
// timeline.jsonl (one JSON object per line)

export interface TimelineItem {
  /** A node id. */
  ref: string;
  change: ChangeKind;
  note?: string;
}

export interface TimelineEntry {
  /** ISO-8601 time. */
  at: string;
  source: TimelineSource;
  title: string;
  request?: string;
  /** Cited prose. */
  summary: string;
  items: TimelineItem[];
  base?: string;
  head?: string;
}

// ---------------------------------------------------------------------------
// view.json

export interface NodeMetrics {
  loc: number;
  pagerank: number;
  churn: number;
  tests: number;
}

export interface EntityFieldView {
  name: string;
  type: string;
  relation?: string;
}

/** mod: the module a slice is part of, and the system it sits in (docs/design.md §2). */
export interface ModuleSlice {
  /** The whole module's id (`mod:src`), itself the slice in the system holding most of its files. */
  of: string;
  /** The system this slice's files sit in (`sys:database`). */
  system: string;
  /** What to show after the shared label to tell slices apart: `@ <system label>` (`@ Database`). */
  qualifier: string;
}

export interface ViewNode {
  id: string;
  kind: NodeKind;
  label: string;
  /**
   * Structural parent (sys ⊃ mod ⊃ file ⊃ sym/route/screen/job/entity). Absent for top-level nodes.
   * A file's system is the one its globs declare; its parent is the slice of its module in that system.
   */
  parent?: string;
  summary?: string;
  /** Citations found in `summary` (`path:line`). */
  cites: string[];
  /** Where a detected node is defined (`path:line`). */
  at?: string;
  metrics: NodeMetrics;
  /** Capabilities this node serves (claimed, inherited from a claimed ancestor, or aggregated from its children). */
  caps: string[];
  tags: string[];
  /** sys: the model's system kind. */
  role?: SystemKind;
  /** cap: who uses it. */
  actors?: string[];
  /** entity: its fields. */
  fields?: EntityFieldView[];
  /**
   * mod: set on a minority slice (`mod:<slug>@<sys>`, tagged `slice`) — the
   * files of module `of` that sit in another system than the majority's.
   * Absent on `mod:<slug>` itself.
   */
  slice?: ModuleSlice;
}

export interface ViewEdge {
  from: string;
  to: string;
  kind: ViewEdgeKind;
  /** Underlying references: for a roll-up, the summed weight of the file-level edges it aggregates. */
  weight: number;
  /** True for everything ultraview detected or aggregated; false for model.json edges. */
  derived: boolean;
  label?: string;
  /** model.json edges: the `path:line` they rest on. */
  cite?: string;
}

export interface ViewCoverage {
  /** Share of code files that a (non-`_unassigned`) system holds. */
  filesInSystems: number;
  /** Share of non-test code modules that a model capability (not `_foundations`) claims. */
  modulesInCapabilities: number;
}

export interface ViewStale {
  /** Lens ids whose cited files changed since `lens save`. */
  lenses: string[];
  /** Flow ids whose cited files changed since `flow save`. */
  flows: string[];
  /** Module node ids whose ultraindex prose is stale. */
  prose: string[];
}

export interface ViewModel {
  schema: typeof VIEW_SCHEMA;
  repo: { name: string; commit?: string; remote?: string };
  app: { name: string; summary?: string; cites: string[]; audience: Audience };
  nodes: ViewNode[];
  edges: ViewEdge[];
  flows: Flow[];
  lenses: Lens[];
  timeline: TimelineEntry[];
  /** The latest change view (filled by `diff --record`, later). */
  changes: null;
  /** Engine-grounded insights (filled by `insights`, later). */
  insights: unknown[];
  glossary: GlossaryEntry[];
  tour: TourStop[];
  coverage: ViewCoverage;
  stale: ViewStale;
}
