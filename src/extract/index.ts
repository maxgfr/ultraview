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
import { expressExtractor, expressMountLinker } from "./express.js";
import { extOf } from "./mask.js";
import { entityUseLinker, prismaClientExtractor, prismaLinker, prismaSchemaExtractor } from "./prisma.js";
import { type ExtractOutput, type Extractor, FACT_KINDS, FACTS_SCHEMA, type FactKind, type Facts, type LinkHint, type Linker } from "./types.js";

export type * from "./types.js";
export { FACT_KINDS, FACTS_SCHEMA } from "./types.js";
export { createRepoContext } from "./context.js";
export { commentSyntaxFor, maskComments, maskSource } from "./mask.js";

/** Every extractor, in a fixed order. Planned ones are listed in src/extract/README.md. */
export const EXTRACTORS: readonly Extractor[] = [expressExtractor, prismaSchemaExtractor, prismaClientExtractor];

/** Repo-level passes, in order: structure first (mounts), then name resolution. */
export const LINKERS: readonly Linker[] = [expressMountLinker, prismaLinker, entityUseLinker];

export function emptyFacts(): Facts {
  return { schema: FACTS_SCHEMA, routes: [], calls: [], screens: [], entities: [], entityUses: [], jobs: [], externals: [], infra: [] };
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
    for (const ex of candidates) {
      let got: ExtractOutput;
      try {
        if (!ex.applies(input, ctx)) continue;
        got = ex.extract(input, ctx);
      } catch (e) {
        opts.onError?.({ extractor: ex.id, file: rel, message: (e as Error).message });
        continue;
      }
      for (const kind of FACT_KINDS) {
        const rows = got[kind];
        if (rows?.length) (merged[kind] as unknown[]).push(...rows);
      }
      if (got.hints?.length) hints.push(...got.hints);
    }
  }
  let facts = merged;
  const linkCtx = { ...ctx, hints };
  for (const linker of linkers) facts = linker.link(facts, linkCtx);
  return normalizeFacts(facts);
}
