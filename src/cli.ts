// The ultraview CLI. The only module that prints or sets an exit status:
// every command is a library call (src/build.ts, src/status.ts) whose result
// this file renders, as plain text for an agent or as JSON with --json.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildMap } from "./build.js";
import { codeindex, ULTRAINDEX_VERSION } from "./engine.js";
import { formatBuildSummary } from "./summary.js";
import { readStatus, type StatusReport } from "./status.js";
import { ULTRAVIEW_VERSION } from "./version.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const HELP = `ultraview v${ULTRAVIEW_VERSION} (ultraindex ${ULTRAINDEX_VERSION}, codeindex ${codeindex.ENGINE_VERSION})
See your app instead of reading its code: a cited map of a repository, built
from the ultraindex index plus deterministic extractors (routes, data models,
…). Under construction: build and status only.

Usage:
  ultraview <command> [options]

Commands:
  build      Refresh the ultraindex index (incremental, into <repo>/.ultraindex),
             run the extractors over every indexed file, and write
             <repo>/.ultraview/facts.json and <repo>/.ultraview/.gitignore.
             Prints a short summary for the agent: files, languages,
             workspaces, top modules by PageRank, fact counts with examples,
             externals, and the next step.
  status     Where the repo stands and what to do next: no-index, index-stale,
             no-model, model-incomplete, stale-views or ready, with a worklist.

Options:
  --repo <dir>   Repository to map (default: the current directory)
  --no-ast       build: skip loading the tree-sitter grammars (regex symbols,
                 no network). Grammars are otherwise pulled once per machine
                 into the shared codeindex cache; CODEINDEX_NO_GRAMMARS_PULL=1
                 forbids the download.
  --json         Machine-readable output (the full result object)
  -h, --help     Show this help
  -v, --version  Show the version
`;

export const COMMANDS = ["build", "status"];
export const VALUE_FLAGS = ["repo"];
export const BOOL_FLAGS = ["json", "no-ast"];

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
  if (p.positional.length) {
    io.err(`ultraview: unexpected argument: ${p.positional[0]}\n`);
    return EXIT_USAGE;
  }
  try {
    if (p.command === "build") return await cmdBuild(p, io);
    return await cmdStatus(p, io);
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
