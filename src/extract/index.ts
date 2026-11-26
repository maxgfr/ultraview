// The extractor registry and the pass that turns indexed files into facts.
//
// `runExtractors` reads each file once, offers it to every extractor whose
// `applies` gate accepts it, merges what they return, runs the repo-level
// linkers, and returns facts in one deterministic order — so two runs over the
// same files produce byte-identical `facts.json`.

import { join } from "node:path";
import { codeindex } from "../engine.js";
import { stableJson } from "../json.js";
import { createRepoContext } from "./context.js";
import { type ExtentOf, extentFinder } from "./extent.js";
import { expressExtractor, expressMountLinker } from "./express.js";
import { extOf } from "./mask.js";
import { entityUseLinker, prismaClientExtractor, prismaLinker, prismaSchemaExtractor } from "./prisma.js";
import { type ExtractOutput, type Extractor, FACT_KINDS, FACTS_SCHEMA, type FactKind, type Facts, type LinkFact, type LinkHint, type Linker } from "./types.js";
// --- issue #2: python, sql, jobs, externals, infra ---
import { externalsExtractor } from "./externals.js";
import { composeExtractor, dockerfileExtractor, k8sExtractor } from "./infra.js";
import { bullmqExtractor, celeryExtractor, githubScheduleExtractor, nodeCronExtractor, vercelCronExtractor } from "./jobs.js";
import { pythonHttpExtractor } from "./python-http.js";
import { djangoModelsExtractor, djangoOrmExtractor, ormRelationLinker, sqlalchemyModelsExtractor, sqlalchemyOrmExtractor } from "./python-orm.js";
import { djangoUrlsExtractor, drfViewsetExtractor, drfViewsetLinker, fastapiExtractor, flaskExtractor, pythonMountLinker } from "./python-routes.js";
import { sqlLiteralExtractor, sqlMigrationLinker, sqlSchemaExtractor, sqlUseLinker } from "./sql.js";

/** Python routes, HTTP calls and ORMs; SQL schemas and literals; jobs; externals; infra. */
const PY_OPS_EXTRACTORS: readonly Extractor[] = [
  fastapiExtractor,
  flaskExtractor,
  djangoUrlsExtractor,
  drfViewsetExtractor,
  pythonHttpExtractor,
  sqlalchemyModelsExtractor,
  sqlalchemyOrmExtractor,
  djangoModelsExtractor,
  djangoOrmExtractor,
  sqlSchemaExtractor,
  sqlLiteralExtractor,
  bullmqExtractor,
  nodeCronExtractor,
  celeryExtractor,
  vercelCronExtractor,
  githubScheduleExtractor,
  externalsExtractor,
  composeExtractor,
  dockerfileExtractor,
  k8sExtractor,
];

/** Python mount prefixes and DRF actions; SQL migrations replayed into one entity per table; then ORM / SQL relation and table resolution (before `entity-uses`). */
const PY_OPS_LINKERS: readonly Linker[] = [pythonMountLinker, drfViewsetLinker, sqlMigrationLinker, ormRelationLinker, sqlUseLinker];
// --- end issue #2 ---

// --- issue #1: JS/TS web ---
import { drizzleExtractor } from "./drizzle.js";
import { nextAppExtractor, nextPagesExtractor, nuxtPagesExtractor, nuxtServerExtractor, remixExtractor, svelteKitExtractor } from "./fs-routes.js";
import { httpCallLinker, httpCallsExtractor } from "./http-calls.js";
import { mongooseExtractor } from "./mongoose.js";
import { nestjsExtractor } from "./nestjs.js";
import { ormFieldsLinker } from "./orm.js";
import { reactRouterExtractor, vueRouterExtractor } from "./route-tables.js";
import { sequelizeExtractor } from "./sequelize.js";
import { fastifyExtractor, honoExtractor, jsMountLinker } from "./servers.js";
import { typeormExtractor } from "./typeorm.js";

/** JS/TS web extractors: file-system routers, server frameworks, HTTP calls, route tables, ORMs. */
const JS_WEB_EXTRACTORS: readonly Extractor[] = [
  nextAppExtractor,
  nextPagesExtractor,
  nuxtServerExtractor,
  nuxtPagesExtractor,
  svelteKitExtractor,
  remixExtractor,
  honoExtractor,
  fastifyExtractor,
  nestjsExtractor,
  httpCallsExtractor,
  reactRouterExtractor,
  vueRouterExtractor,
  drizzleExtractor,
  typeormExtractor,
  mongooseExtractor,
  sequelizeExtractor,
];

/** Structure first (cross-file prefixes, entity fields), before any name resolution. */
const JS_WEB_LINKERS: readonly Linker[] = [jsMountLinker, ormFieldsLinker];

/** Calls → routes: after every linker that moves or adds routes. */
const JS_WEB_CALL_LINKERS: readonly Linker[] = [httpCallLinker];
// --- end issue #1 ---

// --- issue #6: RPC, precise externals, deduped infra ---
import { externalHostsLinker } from "./externals.js";
import { infraOverlayLinker } from "./infra.js";
import { nextActionsExtractor, rpcLinker, trpcExtractor } from "./rpc.js";

/** tRPC routers and calls, Next server actions. */
const RPC_EXTRACTORS: readonly Extractor[] = [trpcExtractor, nextActionsExtractor];

/** RPC routes composed and calls settled (before HTTP calls); then hosts of absolute-URL calls, and one infra fact per unit. */
const RPC_LINKERS: readonly Linker[] = [rpcLinker];
const LATE_LINKERS: readonly Linker[] = [externalHostsLinker, infraOverlayLinker];
// --- end issue #6 ---

export type * from "./types.js";
export { FACT_KINDS, FACTS_SCHEMA } from "./types.js";
export { createRepoContext } from "./context.js";
export { commentSyntaxFor, maskComments, maskSource } from "./mask.js";

/** Every extractor, in a fixed order. Planned ones are listed in src/extract/README.md. */
export const EXTRACTORS: readonly Extractor[] = [
  expressExtractor,
  prismaSchemaExtractor,
  prismaClientExtractor,
  ...JS_WEB_EXTRACTORS,
  ...RPC_EXTRACTORS,
  ...PY_OPS_EXTRACTORS,
];

/** Repo-level passes, in order: structure first (mounts), then name resolution. */
export const LINKERS: readonly Linker[] = [
  expressMountLinker,
  ...JS_WEB_LINKERS,
  prismaLinker,
  ...PY_OPS_LINKERS,
  ...RPC_LINKERS,
  ...JS_WEB_CALL_LINKERS,
  entityUseLinker,
  ...LATE_LINKERS,
];

type FactExtentRow = Facts[(typeof EXTENT_KINDS)[number]][number];

/** The fact kinds that carry an extent (`end`): the ones a hunk can change. */
export const EXTENT_KINDS = ["routes", "calls", "screens", "entities", "jobs"] as const satisfies readonly FactKind[];

export function emptyFacts(): Facts {
  return { schema: FACTS_SCHEMA, routes: [], calls: [], screens: [], entities: [], entityUses: [], jobs: [], externals: [], infra: [], links: [] };
}

/** Locations kept per hyperlink host: enough to cite, small enough to keep facts.json lean. */
export const LINKS_PER_HOST = 3;

/**
 * Hyperlinks sorted by file, line, host; deduplicated; hosts that are an
 * external (`via: "host"`) dropped; at most `LINKS_PER_HOST` locations per host
 * (the first ones in that order).
 */
function normalizeLinks(links: readonly LinkFact[], externals: readonly Facts["externals"][number][]): LinkFact[] {
  const hostExternals = new Set(externals.filter((x) => x.via === "host").map((x) => x.id));
  const sorted = [...links].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.host, b.host));
  const perHost = new Map<string, number>();
  const seen = new Set<string>();
  const out: LinkFact[] = [];
  for (const l of sorted) {
    if (hostExternals.has(l.host)) continue;
    const key = `${l.host}\u0000${l.file}\u0000${l.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = perHost.get(l.host) ?? 0;
    if (n >= LINKS_PER_HOST) continue;
    perHost.set(l.host, n + 1);
    out.push({ host: l.host, file: l.file, line: l.line });
  }
  return out;
}

/** The identity of a record within its kind, used to order records sharing a file and line. */
function identity(kind: FactKind, r: Record<string, unknown>): string {
  switch (kind) {
    case "routes":
      return `${r.method} ${r.path}`;
    case "calls":
      return `${r.method} ${r.url}`;
    case "screens":
      return String(r.path);
    case "entities":
      return String(r.name);
    case "entityUses":
      return `${r.entity} ${r.op}`;
    default:
      return String(r.id);
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sort every kind by file, line, then identity (full record as the last tiebreak), and drop exact duplicates. */
export function normalizeFacts(facts: Facts): Facts {
  const out = emptyFacts();
  for (const kind of FACT_KINDS) {
    const rows = (facts[kind] as unknown as Record<string, unknown>[]).map((r) => ({ r, key: stableJson(r) }));
    rows.sort(
      (a, b) =>
        cmp(String(a.r.file), String(b.r.file)) ||
        (a.r.line as number) - (b.r.line as number) ||
        cmp(identity(kind, a.r), identity(kind, b.r)) ||
        cmp(a.key, b.key),
    );
    const seen = new Set<string>();
    const kept: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      kept.push(row.r);
    }
    (out as unknown as Record<string, unknown[]>)[kind] = kept;
  }
  out.links = normalizeLinks(facts.links ?? [], out.externals);
  return out;
}

export interface ExtractorFailure {
  extractor: string;
  file: string;
  message: string;
}

export interface RunExtractorsOptions {
  extractors?: readonly Extractor[];
  linkers?: readonly Linker[];
  /** Test-file predicate. Default: the engine's own (`codeindex.isTestPath`). */
  isTest?: (rel: string) => boolean;
  /** Called when an extractor throws on a file; the file's other extractors still run. */
  onError?: (failure: ExtractorFailure) => void;
}

/**
 * Run the extractors over `files` (repo-relative) of the repository at `repo`.
 * `readText` receives an absolute path and returns the file's text, or
 * undefined when it cannot be read — the only I/O, and it is the caller's.
 */
export function runExtractors(repo: string, files: readonly string[], readText: (abs: string) => string | undefined, opts: RunExtractorsOptions = {}): Facts {
  const extractors = opts.extractors ?? EXTRACTORS;
  const linkers = opts.linkers ?? LINKERS;
  const isTest = opts.isTest ?? codeindex.isTestPath;
  const texts = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!texts.has(rel)) texts.set(rel, readText(join(repo, rel)));
    return texts.get(rel);
  };
  const ctx = createRepoContext(files, read);
  const merged = emptyFacts();
  const hints: LinkHint[] = [];
  for (const rel of ctx.files) {
    const test = isTest(rel);
    const candidates = extractors.filter((e) => !test || e.includeTests);
    if (!candidates.length) continue;
    const text = read(rel);
    texts.delete(rel);
    if (text === undefined || text === "") continue;
    const input = { rel, text, lang: codeindex.extToLang(extOf(rel)) };
    let extent: ExtentOf | undefined;
    for (const ex of candidates) {
      let got: ExtractOutput;
      try {
        if (!ex.applies(input, ctx)) continue;
        got = ex.extract(input, ctx);
      } catch (e) {
        opts.onError?.({ extractor: ex.id, file: rel, message: (e as Error).message });
        continue;
      }
      // Extents while the text is at hand: an extractor's own `end` wins, else the statement its line starts.
      for (const kind of EXTENT_KINDS) {
        for (const row of got[kind] ?? []) {
          if (row.end !== undefined || row.file !== rel) continue;
          extent ??= extentFinder(rel, text);
          row.end = extent(row.line);
        }
      }
      for (const kind of FACT_KINDS) {
        const rows = got[kind];
        if (rows?.length) (merged[kind] as unknown[]).push(...rows);
      }
      if (got.links?.length) merged.links?.push(...got.links);
      if (got.hints?.length) hints.push(...got.hints);
    }
  }
  let facts = merged;
  const linkCtx = { ...ctx, hints };
  for (const linker of linkers) facts = linker.link(facts, linkCtx);
  // Facts a linker made from hints (tRPC procedures, settled calls) get their extents now.
  const pending = new Map<string, FactExtentRow[]>();
  for (const kind of EXTENT_KINDS) {
    for (const row of facts[kind]) {
      if (row.end !== undefined) continue;
      const rows = pending.get(row.file);
      if (rows) rows.push(row);
      else pending.set(row.file, [row]);
    }
  }
  for (const [rel, rows] of pending) {
    const text = readText(join(repo, rel));
    if (text === undefined) continue;
    const extent = extentFinder(rel, text);
    for (const row of rows) row.end = extent(row.line);
  }
  return normalizeFacts(facts);
}
