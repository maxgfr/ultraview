// The engine's in-memory scan of the repository, rebuilt from the ultraindex
// extraction cache (no re-extraction of unchanged files), with the scan options
// the index was built with. The codeindex analyses that need more than the
// graph (dead code, literal duplication, hotspots, broken imports) take it.

import { codeindex, loadCache, loadManifest } from "./engine.js";
import { viewPaths } from "./paths.js";

export type RepoScan = ReturnType<typeof codeindex.scanRepo>;

/** A scan of `repo` matching its ultraindex index (same include / exclude / limits), served from the index's cache. */
export function indexedScan(repo: string): RepoScan {
  const index = viewPaths(repo).index;
  const scan = loadManifest(index)?.scan;
  return codeindex.scanRepo(repo, {
    include: scan?.include,
    exclude: scan?.exclude,
    maxBytes: scan?.maxBytes,
    maxFiles: scan?.maxFiles,
    ...(scan?.gitignore === false ? { gitignore: false } : {}),
    out: index,
    cache: loadCache(index),
  });
}
