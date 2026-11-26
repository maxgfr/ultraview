// The ultraview CLI. The only module that prints or sets an exit status:
// every command is a library call (src/build.ts, src/status.ts, src/check.ts,
// src/dossier.ts, src/show.ts, src/save.ts) whose result this file renders, as
// plain text for an agent or as JSON with --json.

import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMap } from "./build.js";
import { type CheckReport, checkMap, formatIssue } from "./check.js";
import { DOSSIER_BUDGET, renderNodeDossier } from "./dossier.js";
import { codeindex, ULTRAINDEX_VERSION } from "./engine.js";
import { type SaveResult, saveFlow, saveLens } from "./save.js";
import { openFile, renderMap } from "./render.js";
import { formatNodeCard, liveView, nodeCard, similarIds } from "./show.js";
import { formatBuildSummary } from "./summary.js";
import { readStatus, type StatusReport } from "./status.js";
import { ULTRAVIEW_VERSION } from "./version.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const HELP = `ultraview v${ULTRAVIEW_VERSION} (ultraindex ${ULTRAINDEX_VERSION}, codeindex ${codeindex.ENGINE_VERSION})
See your app instead of reading its code: a cited map of a repository, built
from the ultraindex index plus deterministic extractors (routes, data models,
…) and the meaning the agent writes into .ultraview/ (model, flows, lenses),
drawn as one offline HTML page.

Usage:
  ultraview <command> [options]

Commands:
  build              Refresh the ultraindex index (incremental, into
                     <repo>/.ultraindex), run the extractors over every indexed
                     file, merge everything into the view-model, and write
                     <repo>/.ultraview/facts.json, view.json and .gitignore.
                     Prints a short summary for the agent: files, languages,
                     workspaces, top modules by PageRank, fact counts with
                     examples, externals, view size and coverage, next step.
  status             Where the repo stands and what to do next: no-index,
                     index-stale, no-model, model-incomplete, stale-views or
                     ready, with a worklist.
  check              The gate for what the agent wrote: schema, node ids that
                     resolve, citations that resolve (ultraindex
                     checkCitations), one citation per sentence, coverage
                     (systems >= 90% of code files, capabilities >= 70% of
                     non-test modules), stale lenses / flows (warnings).
                     Exit 1 on failure.
  dossier <node-id>  Evidence pack to write about one node: real source,
                     facts with file:line, neighbours. Cut to --budget tokens.
  show <node-id>     Compact card for one node: kind, label, parent,
                     capabilities, summary, citations, metrics, top edges.
  lens save <file>   Validate a lens (one saved question and its cited
                     answer), stamp the hashes of the files it cites, write
                     .ultraview/lenses/<id>.json.
  flow save <file>   Same for a flow: .ultraview/flows/<id>.json.
  render             Embed .ultraview/view.json into the offline viewer and
                     write one self-contained page, .ultraview/index.html
                     (or --out): the map with semantic zoom, data models,
                     flows, saved questions, changes, search and tour.
                     --open opens it in the default browser.

Options:
  --repo <dir>   Repository to map (default: the current directory)
  --no-ast       build: skip loading the tree-sitter grammars (regex symbols,
                 no network). Grammars are otherwise pulled once per machine
                 into the shared codeindex cache; CODEINDEX_NO_GRAMMARS_PULL=1
                 forbids the download.
  --strict       check: stale lenses / flows fail instead of warning
  --budget <n>   dossier: token budget (default ${DOSSIER_BUDGET}, ~4 characters a token)
  --force        lens save / flow save: replace a different question / title
                 saved under the same id
  --out <file>   render: where to write the page (default
                 <repo>/.ultraview/index.html)
  --open         render: open the page with the OS opener afterwards
  --json         Machine-readable output (the full result object)
  -h, --help     Show this help
  -v, --version  Show the version

Exit codes: 0 ok, 1 failure (check failed, save refused), 2 usage error or
unknown node id.
`;

export const COMMANDS = ["build", "status", "check", "dossier", "show", "lens", "flow", "render"];
export const VALUE_FLAGS = ["repo", "budget", "out"];
export const BOOL_FLAGS = ["json", "no-ast", "strict", "force", "open"];

/** Positional arguments each command takes (after the command name). */
const ARITY: Record<string, { min: number; max: number; usage: string }> = {
  build: { min: 0, max: 0, usage: "build" },
  status: { min: 0, max: 0, usage: "status" },
  check: { min: 0, max: 0, usage: "check" },
  dossier: { min: 1, max: 1, usage: "dossier <node-id>" },
  show: { min: 1, max: 1, usage: "show <node-id>" },
  lens: { min: 2, max: 2, usage: "lens save <file>" },
  flow: { min: 2, max: 2, usage: "flow save <file>" },
  render: { min: 0, max: 0, usage: "render [--out <file>] [--open]" },
};

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const processIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface Parsed {
  command?: string;
  values: Record<string, string>;
  bools: Set<string>;
  positional: string[];
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): Parsed | { error: string } {
  const parsed: Parsed = { values: {}, bools: new Set(), positional: [], help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      parsed.version = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (BOOL_FLAGS.includes(key)) {
        if (eq !== -1) return { error: `--${key} is a boolean flag and takes no value` };
        parsed.bools.add(key);
        continue;
      }
      if (!VALUE_FLAGS.includes(key)) return { error: `unknown flag: --${key} (run --help for the options)` };
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) return { error: `missing value for --${key}` };
        i++;
      }
      parsed.values[key] = value;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") return { error: `unknown option: ${arg} (run --help for the options)` };
    if (parsed.command === undefined) parsed.command = arg;
    else parsed.positional.push(arg);
  }
  if (parsed.command !== undefined && !COMMANDS.includes(parsed.command)) return { error: `unknown command: ${parsed.command} (run --help for usage)` };
  return parsed;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatStatus(s: StatusReport): string {
  const lines = [`situation  ${s.situation}`, `repo       ${s.repo}`];
  for (const r of s.reasons) lines.push(`  - ${r}`);
  if (s.worklist.length) {
    lines.push("next");
    s.worklist.forEach((w, i) => {
      lines.push(`  ${i + 1}. ${w}`);
    });
  }
  return `${lines.join("\n")}\n`;
}

async function cmdBuild(p: Parsed, io: Io): Promise<number> {
  const result = await buildMap({ repo: p.values.repo ?? ".", ast: !p.bools.has("no-ast") });
  io.out(p.bools.has("json") ? json(result) : formatBuildSummary(result));
  if (!p.bools.has("json") && result.grammars.notes.length && !result.grammars.ast && !p.bools.has("no-ast")) {
    io.err("ultraview: tree-sitter grammars unavailable (offline?): indexed with the regex extractor, symbols are less precise.\n");
  }
  return result.failures.length ? EXIT_FAILURE : EXIT_OK;
}

async function cmdStatus(p: Parsed, io: Io): Promise<number> {
  const report = readStatus(p.values.repo ?? ".");
  io.out(p.bools.has("json") ? json(report) : formatStatus(report));
  return EXIT_OK;
}

export function formatCheck(r: CheckReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `check      ${r.ok ? "ok" : `FAILED (${r.errors.length} error(s))`}${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ""}`,
    `coverage   files in systems ${pct(r.coverage.filesInSystems)} (min ${pct(r.thresholds.filesInSystems)}), modules in capabilities ${pct(r.coverage.modulesInCapabilities)} (min ${pct(r.thresholds.modulesInCapabilities)})`,
  ];
  if (r.errors.length) {
    lines.push("errors");
    for (const e of r.errors) lines.push(`  ${formatIssue(e)}`);
  }
  if (r.warnings.length) {
    lines.push("warnings");
    for (const w of r.warnings) lines.push(`  ${formatIssue(w)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function cmdCheck(p: Parsed, io: Io): Promise<number> {
  const report = checkMap(p.values.repo ?? ".", { strict: p.bools.has("strict") });
  io.out(p.bools.has("json") ? json(report) : formatCheck(report));
  return report.ok ? EXIT_OK : EXIT_FAILURE;
}

function unknownId(p: Parsed, io: Io, id: string, suggestions: string[]): number {
  const hint = suggestions.length ? ` (did you mean: ${suggestions.join(", ")}?)` : "";
  if (p.bools.has("json")) io.out(json({ error: `unknown node id: ${id}`, suggestions }));
  io.err(`ultraview: unknown node id: ${id}${hint}\n`);
  return EXIT_USAGE;
}

async function cmdShow(p: Parsed, io: Io): Promise<number> {
  const id = p.positional[0] as string;
  const live = liveView(p.values.repo ?? ".");
  const card = nodeCard(live, id);
  if (!card) return unknownId(p, io, id, similarIds(live.view, id));
  io.out(p.bools.has("json") ? json(card) : formatNodeCard(card));
  return EXIT_OK;
}

async function cmdDossier(p: Parsed, io: Io): Promise<number> {
  const id = p.positional[0] as string;
  let budget: number | undefined;
  if (p.values.budget !== undefined) {
    budget = Number(p.values.budget);
    if (!Number.isInteger(budget) || budget <= 0) {
      io.err(`ultraview: --budget must be a positive integer (got ${p.values.budget})\n`);
      return EXIT_USAGE;
    }
  }
  const repo = resolve(p.values.repo ?? ".");
  const live = liveView(repo);
  const text = renderNodeDossier(live, repo, id, { budget });
  if (text === undefined) return unknownId(p, io, id, similarIds(live.view, id));
  io.out(p.bools.has("json") ? json({ id, budget: budget ?? DOSSIER_BUDGET, text }) : text);
  return EXIT_OK;
}

async function cmdSave(p: Parsed, io: Io, what: "lens" | "flow"): Promise<number> {
  const [action, file] = p.positional as [string, string];
  if (action !== "save") {
    io.err(`ultraview: unknown ${what} action: ${action} (only \`${what} save <file>\` for now)\n`);
    return EXIT_USAGE;
  }
  let text: string;
  try {
    text = readFileSync(resolve(file), "utf8");
  } catch (e) {
    io.err(`ultraview: cannot read ${file}: ${(e as Error).message}\n`);
    return EXIT_FAILURE;
  }
  const repo = p.values.repo ?? ".";
  const opts = { force: p.bools.has("force") };
  const r: SaveResult = what === "lens" ? saveLens(repo, text, opts) : saveFlow(repo, text, opts);
  if (p.bools.has("json")) io.out(json(r));
  else if (r.ok) {
    const n = Object.keys(r.sources).length;
    io.out(`saved      ${r.file}${r.replaced ? " (replaced)" : ""}; sources: ${n} cited file(s) hashed\nnext step: run \`ultraview check\`\n`);
  } else {
    io.err(`ultraview: ${what} not saved${r.file ? ` (${r.file})` : ""}:\n${r.errors.map((e) => `  ${e.path || "(root)"}: ${e.message}`).join("\n")}\n`);
  }
  return r.ok ? EXIT_OK : EXIT_FAILURE;
}

async function cmdRender(p: Parsed, io: Io): Promise<number> {
  const r = renderMap({ repo: p.values.repo ?? ".", out: p.values.out });
  const opened = p.bools.has("open") ? await openFile(r.out) : undefined;
  if (p.bools.has("json")) io.out(json({ ...r, ...(opened !== undefined ? { opened } : {}) }));
  else {
    const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
    const shown = relative(process.cwd(), r.out);
    io.out(`rendered   ${shown && !shown.startsWith("..") ? shown : r.out} (${kb(r.bytes)}: view ${kb(r.viewBytes)} + viewer ${kb(r.viewerBytes)})\n`);
    if (opened === false) io.out("open       no opener found: open the file in a browser\n");
    else if (!opened) io.out("next step: open it in a browser (offline, one file), or pass --open\n");
  }
  return EXIT_OK;
}

export async function main(argv: readonly string[], io: Io = processIo): Promise<number> {
  const p = parseArgs(argv);
  if ("error" in p) {
    io.err(`ultraview: ${p.error}\n`);
    return EXIT_USAGE;
  }
  if (p.version) {
    io.out(
      p.bools.has("json")
        ? json({ ultraview: ULTRAVIEW_VERSION, ultraindex: ULTRAINDEX_VERSION, codeindex: codeindex.ENGINE_VERSION })
        : `${ULTRAVIEW_VERSION}\n`,
    );
    return EXIT_OK;
  }
  if (p.help || p.command === undefined) {
    io.out(HELP);
    return EXIT_OK;
  }
  const arity = ARITY[p.command]!;
  if (p.positional.length > arity.max) {
    io.err(`ultraview: unexpected argument: ${p.positional[arity.max]} (usage: ultraview ${arity.usage})\n`);
    return EXIT_USAGE;
  }
  if (p.positional.length < arity.min) {
    io.err(`ultraview: missing argument (usage: ultraview ${arity.usage})\n`);
    return EXIT_USAGE;
  }
  try {
    switch (p.command) {
      case "build":
        return await cmdBuild(p, io);
      case "check":
        return await cmdCheck(p, io);
      case "show":
        return await cmdShow(p, io);
      case "dossier":
        return await cmdDossier(p, io);
      case "lens":
      case "flow":
        return await cmdSave(p, io, p.command);
      case "render":
        return await cmdRender(p, io);
      default:
        return await cmdStatus(p, io);
    }
  } catch (e) {
    const message = (e as Error).message;
    if (p.bools.has("json")) io.out(json({ error: message }));
    io.err(`ultraview: ${message}\n`);
    return EXIT_FAILURE;
  }
}

function startedAsProgram(): boolean {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

// Only when run as a program: `webindex skill bundle` imports the built file to
// read HELP and the flag tables, and importing must not start anything.
if (startedAsProgram()) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") process.exit(EXIT_OK);
      throw e;
    });
  }
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`ultraview: ${(e as Error).message}\n`);
      process.exitCode = EXIT_FAILURE;
    },
  );
}
