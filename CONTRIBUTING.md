# Contributing

## Architecture in one minute

A thin, deterministic CLI over the vendored ultraindex library
(`src/vendor/ultraindex-engine.mjs`, reached only through `src/engine.ts`),
which carries the pinned codeindex engine as its `codeindex` namespace.
`src/build.ts` refreshes the index and runs the extractors in `src/extract/`
(pure functions: path + text + repo context in, facts out) into
`.ultraview/facts.json`; `src/status.ts` routes the agent. tsup bundles
everything into one dependency-free `scripts/ultraview.mjs`, copied into the
skill. The viewer lives in `viewer/` (TypeScript + Preact; pure logic in
`viewer/lib/`, unit-tested in node; components in `viewer/ui/`; strings in
`viewer/i18n/`): `scripts/build-viewer.mjs` bundles it with esbuild and
inlines it, with the elkjs layout worker, into one offline
`skills/ultraview/assets/viewer.html` that `ultraview render` fills with
`.ultraview/view.json`. The full spec is [docs/design.md](docs/design.md).

## Prerequisites

Node 20+ and pnpm for development; the bundle runs on Node 18+.

```bash
pnpm install
pnpm run typecheck && pnpm run lint && pnpm test && pnpm run check:build
```

## Rules

1. TDD: write the failing test first. Every extractor ships true-positive
   tests AND false-positive guards (comments, strings, tests, docs).
2. Extractors stay pure: no file system, network or model, so they can move
   upstream to codeindex unchanged.
3. Reuse an engine export before writing a helper (`webindex skill check`
   refuses a re-declared one).
4. Generated files are byte-stable: sorted keys, sorted arrays, trailing newline.
5. `pnpm run build` and commit the bundle with the source: CI fails when they differ.
6. SKILL.md description stays under 1000 characters; every documented
   `--flag` exists in `--help` (`webindex skill bundle`).

## Commits and releases

[Conventional Commits](https://www.conventionalcommits.org/): `feat:` → minor,
`fix:` → patch, `!` → major. semantic-release cuts the release from `main` in
CI. Commits are signed.
