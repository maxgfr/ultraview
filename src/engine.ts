// Curated re-export surface over the vendored ultraindex library
// (src/vendor/ultraindex-engine.mjs), which itself re-exports the pinned
// codeindex engine as the `codeindex` namespace. ONE engine copy: nothing under
// src/ imports codeindex from anywhere else.
//
// Everything in src/ reaches the engine through THIS module, never through
// src/vendor/ directly. Explicit named re-exports instead of `export *`: every
// name ultraview consumes is visible in one place, unused vendor surface does
// not leak through by accident, and a genuine name collision becomes a compile
// error (TS2300 "Duplicate identifier") instead of `export *`'s silent
// exclude-the-ambiguous-name behavior. Add a name here only when something
// under src/ or tests/ needs it.
//
// THE RULE for a capability that moves upstream: its name enters this barrel in
// the SAME commit that deletes the local twin (`webindex skill check` refuses a
// module that declares a name the engine exports).

export type {
  BuildResult,
  CheckResult,
  FileNode,
  Graph,
  Manifest,
  ModuleNode,
  WarmGrammarsResult,
} from "./vendor/ultraindex-engine.mjs";

export {
  VERSION as ULTRAINDEX_VERSION,
  codeindex,
  indexExists,
  loadGraph,
  loadManifest,
  prepareGrammars,
  runBuild,
  runCheck,
} from "./vendor/ultraindex-engine.mjs";
