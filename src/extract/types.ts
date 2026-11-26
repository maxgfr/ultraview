// The facts every extractor contributes to, and the contract an extractor
// implements. Shapes follow docs/design.md §5 exactly: `facts.json` is this
// `Facts` object serialized byte-stable.
//
// Extractors are PURE: (rel path, text, repo context) in, partial facts out. No
// file system, no network, no model. That is what lets one be upstreamed to
// codeindex unchanged, and what makes `facts.json` a function of the files.

export const FACTS_SCHEMA = 1;

/** An HTTP endpoint the app serves. Node id: `route:<METHOD> <path>`. */
export interface RouteFact {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  handler?: string;
}

/** An outbound HTTP call, matched to a route when one serves it. */
export interface CallFact {
  method: string;
  url: string;
  file: string;
  line: number;
  route?: string;
}

/** A page / screen of a UI. Node id: `screen:<path>`. */
export interface ScreenFact {
  path: string;
  file: string;
  line: number;
  framework: string;
}

export interface EntityField {
  name: string;
  type: string;
  /** The related entity's name, when the field's type is another entity. */
  relation?: string;
}

/** A persisted data model. Node id: `entity:<name>`. */
export interface EntityFact {
  name: string;
  orm: string;
  file: string;
  line: number;
  fields: EntityField[];
}

/** A place in the code that reads or writes an entity. */
export interface EntityUseFact {
  entity: string;
  file: string;
  line: number;
  op: "read" | "write";
}

/** A scheduled or queued unit of work. Node id: `job:<id>`. */
export interface JobFact {
  id: string;
  kind: "cron" | "queue" | "worker";
  schedule?: string;
  file: string;
  line: number;
}

/** A third-party service the app talks to. Node id: `ext:<id>`. */
export interface ExternalFact {
  id: string;
  via: "sdk" | "host" | "env";
  file: string;
  line: number;
}

/** A deployable unit declared in infrastructure files. */
export interface InfraFact {
  id: string;
  kind: "compose-service" | "dockerfile" | "k8s";
  file: string;
  line: number;
}

export interface Facts {
  schema: typeof FACTS_SCHEMA;
  routes: RouteFact[];
  calls: CallFact[];
  screens: ScreenFact[];
  entities: EntityFact[];
  entityUses: EntityUseFact[];
  jobs: JobFact[];
  externals: ExternalFact[];
  infra: InfraFact[];
}

/** The fact arrays, in the order `facts.json` and the build summary list them. */
export const FACT_KINDS = ["routes", "calls", "screens", "entities", "entityUses", "jobs", "externals", "infra"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface ExtractInput {
  /** Repo-relative path, posix separators. */
  rel: string;
  text: string;
  /** The engine's language name for the file (`typescript`, `python`, …), when known. */
  lang?: string;
}

export interface RepoContext {
  /** Every indexed file, repo-relative, sorted. */
  files: string[];
  /** Workspace dir ("" = root) → declared dependency names from package.json / pyproject / requirements. */
  deps: Map<string, Set<string>>;
  /** Declared dependencies of the workspace nearest to `rel`. */
  depsFor(rel: string): Set<string>;
}

/**
 * A cross-file relation an extractor saw but cannot resolve alone, handed to
 * the linkers and never persisted. Only kind so far: an Express router mounted
 * under a path prefix from another file (`app.use("/api", ordersRouter)` with
 * `ordersRouter` imported from `./routes/orders`).
 */
export interface MountHint {
  kind: "mount";
  framework: string;
  /** The file doing the mounting. */
  file: string;
  line: number;
  /** The path prefix, as written (`/api`). */
  prefix: string;
  /** The mounted module's import specifier, resolved against `file`'s directory, without extension (`src/routes/orders`). */
  target: string;
}

export type LinkHint = MountHint;

/**
 * What an extractor returns: partial facts, plus optional hints for the
 * linkers. A plain `Partial<Facts>` is a valid result.
 */
export type ExtractOutput = Partial<Omit<Facts, "schema">> & { hints?: LinkHint[] };

export interface Extractor {
  id: string;
  /** Cheap gate, run before `extract`: file shape + declared dependencies. */
  applies(input: ExtractInput, ctx: RepoContext): boolean;
  extract(input: ExtractInput, ctx: RepoContext): ExtractOutput;
  /** Also run on test files (default: false — fixtures and mocks are not the app). */
  includeTests?: boolean;
}

/** What linkers see: the repo context plus every hint the extractors left. */
export interface LinkContext extends RepoContext {
  hints: readonly LinkHint[];
}

/** A repo-level pass over the merged facts, e.g. calls→routes matching, mount prefixes, file-based routing. */
export interface Linker {
  id: string;
  link(facts: Facts, ctx: LinkContext): Facts;
}
