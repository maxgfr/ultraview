// The facts every extractor contributes to, and the contract an extractor
// implements. Shapes follow docs/design.md §5 exactly: `facts.json` is this
// `Facts` object serialized byte-stable.
//
// Extractors are PURE: (rel path, text, repo context) in, partial facts out. No
// file system, no network, no model. That is what lets one be upstreamed to
// codeindex unchanged, and what makes `facts.json` a function of the files.

// Schema history:
//   1  the first shape.
//   2  `links` (hyperlink hosts, kept apart from `externals`), `InfraFact.overlays`,
//      RPC routes and calls (tRPC `QUERY` / `MUTATION` / `SUBSCRIPTION`, Next
//      server actions `ACTION`). Additive: a schema-1 reader still reads it.
export const FACTS_SCHEMA = 2;

/**
 * An endpoint the app serves. Node id: `route:<METHOD> <path>`.
 * HTTP routes: an HTTP method (or `ALL`) and a URL path (`/api/orders/:id`).
 * RPC routes: tRPC procedures (`QUERY` / `MUTATION` / `SUBSCRIPTION`, path =
 * the dotted procedure path `user.byId`, framework `trpc`) and Next server
 * actions (`ACTION`, path = `<repo path without extension>#<export>`,
 * framework `next-action`).
 */
export interface RouteFact {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  handler?: string;
}

/**
 * An outbound call, matched to a route when one serves it: an HTTP call
 * (method + URL), or an RPC call (`QUERY user.byId`, `ACTION app/actions#save`)
 * whose `url` is the route path it names.
 */
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

/**
 * A deployable unit declared in infrastructure files. One fact per id + kind:
 * a unit declared again by environment overlays (`env/dev/…`, `env/prod/…`,
 * kustomize overlays, compose overrides) keeps its first location by path and
 * lists every declaring file in `overlays`.
 */
export interface InfraFact {
  id: string;
  kind: "compose-service" | "dockerfile" | "k8s";
  file: string;
  line: number;
  /** Every file declaring this unit, sorted, when more than one does. */
  overlays?: string[];
}

/**
 * A hyperlink to another site: an absolute URL in a string that reaches no
 * HTTP call, client base URL or configuration (JSX `href`, content and i18n
 * strings). Kept apart from `externals` so a link to a regulator's website is
 * not a service the app depends on. Capped at the first 3 locations per host;
 * hosts that are already an external are not repeated here.
 */
export interface LinkFact {
  /** The registrable domain (`cnil.fr`). */
  host: string;
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
  /** Hyperlink hosts (schema 2). Optional so a schema-1 `facts.json` still reads; `runExtractors` always writes it. */
  links?: LinkFact[];
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
  /** Workspace dir ("" = root) → declared dependency names from package.json / pyproject / requirements / Pipfile / setup.cfg. */
  deps: Map<string, Set<string>>;
  /** Declared dependencies of the workspace nearest to `rel`. */
  depsFor(rel: string): Set<string>;
}

/**
 * A cross-file relation an extractor saw but cannot resolve alone, handed to
 * the linkers and never persisted. A mount: a router served under a path
 * prefix from another file (`app.use("/api", ordersRouter)` with
 * `ordersRouter` imported from `./routes/orders`; Hono `route()`, Fastify
 * `register()` with a prefix; FastAPI `include_router`, Flask
 * `register_blueprint`, Django `include`).
 */
export interface MountHint {
  kind: "mount";
  framework: string;
  /** The file doing the mounting. */
  file: string;
  line: number;
  /** The path prefix, as written (`/api`). */
  prefix: string;
  /**
   * The mounted module, without extension. JS: the import specifier resolved
   * against `file`'s directory (`src/routes/orders`). Python: a module path
   * (`app/routers/orders`) looked up from the repo root, then from each of
   * `file`'s ancestor directories; `|` separates alternatives, the first that
   * names an indexed file wins.
   */
  target: string;
}

/** The SQL table an ORM class maps to (`__tablename__ = "orders"` on `Order`), for FK and SQL-literal resolution. */
export interface TableHint {
  kind: "table";
  orm: string;
  /** The declared entity's name (`Order`). */
  entity: string;
  /** The table it maps to (`orders`). */
  table: string;
  file: string;
  line: number;
}

/** A SQL statement literal naming a table (`"SELECT … FROM orders"`), kept only when the table is declared. */
export interface SqlUseHint {
  kind: "sql-use";
  table: string;
  op: "read" | "write";
  file: string;
  line: number;
}

/** The actions a Django REST framework viewset serves, from its bases and methods, for the routes a router registers it under. */
export interface ViewsetHint {
  kind: "viewset";
  /** The viewset class name (`OrderViewSet`). */
  name: string;
  /** Methods of the list route (`/orders`) and of the detail route (`/orders/:pk`). */
  list: string[];
  detail: string[];
  file: string;
  line: number;
}

/**
 * Fields a file adds to an entity it does not declare: Drizzle `relations()`
 * helpers and Sequelize associations, often written in another file than the
 * table or model. The `orm-fields` linker merges them into the declared entity.
 */
export interface FieldsHint {
  kind: "fields";
  orm: string;
  entity: string;
  file: string;
  line: number;
  fields: EntityField[];
}

/**
 * An HTTP client instance a module exports (`export const api = axios.create({ baseURL: "/api" })`):
 * calls made through it elsewhere are calls to `base` + path.
 */
export interface HttpClientHint {
  kind: "http-client";
  /** The module declaring the client. */
  file: string;
  /** The exported name (`api`, or `default`). */
  name: string;
  /** The normalized base URL: undefined when none, "" when not a literal (dropped). */
  base?: string;
}

/**
 * A call through an imported object that may be an HTTP client
 * (`api.get("/users")` with `api` imported from `./lib/api`). Becomes a call
 * fact only when the module exports a client by that name.
 */
export interface ClientCallHint {
  kind: "client-call";
  file: string;
  line: number;
  method: string;
  /** The normalized URL as written (absolute path, relative path, or full URL). */
  url: string;
  /** The resolved file of the imported module. */
  module: string;
  /** The imported name (`api`, or `default`). */
  name: string;
}

/** A tRPC procedure declared in a router, relative to that router (`byId`). */
export interface RpcProcedure {
  /** Dotted path within the router (`byId`, or `posts.list` for an inline sub-router). */
  path: string;
  method: "QUERY" | "MUTATION" | "SUBSCRIPTION";
  line: number;
}

/** A router another router composes under a key (`user: userRouter`). */
export interface RpcChild {
  /** Dotted key path within the parent router (`user`); "" for `mergeRouters`. */
  prefix: string;
  /** The file declaring the child router (the parent's own file for a same-file router). */
  module: string;
  /** The child's name in that module: its local binding (same file) or the imported name (`default` for a default import). */
  name: string;
}

/**
 * A tRPC router: `export const userRouter = router({ byId: publicProcedure.query(…) })`.
 * The `rpc` linker composes routers by key into full procedure paths
 * (`user.byId`); a router no other router composes is a root.
 */
export interface RpcRouterHint {
  kind: "rpc-router";
  file: string;
  line: number;
  /** The local binding (`userRouter`), or `default` for `export default router({…})`. */
  name: string;
  /** Names other modules import it by: its exported names (`default` included). */
  exports: string[];
  procedures: RpcProcedure[];
  children: RpcChild[];
}

/**
 * A tRPC call without a method-naming terminal (`await api.user.byId({ id })`,
 * a server-side caller): becomes a call fact only when a procedure of that
 * exact path exists, with that procedure's method.
 */
export interface RpcCallHint {
  kind: "rpc-call";
  file: string;
  line: number;
  /** The dotted procedure path (`user.byId`). */
  path: string;
}

/**
 * A use of an imported function that may be a Next server action: a call
 * (`await save(data)`), `action={save}` / `formAction={save}`, or
 * `useActionState(save, …)`. Becomes an `ACTION` call when `module` exports a
 * server action by that name.
 */
export interface ActionCallHint {
  kind: "action-call";
  file: string;
  line: number;
  /** The resolved file of the imported module. */
  module: string;
  /** The imported name (`save`, or `default`). */
  name: string;
}

export type LinkHint =
  | MountHint
  | TableHint
  | SqlUseHint
  | ViewsetHint
  | FieldsHint
  | HttpClientHint
  | ClientCallHint
  | RpcRouterHint
  | RpcCallHint
  | ActionCallHint;

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
