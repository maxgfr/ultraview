// The ultraview CLI. The only module that prints or sets an exit status:
// every command is a library call (src/build.ts, src/status.ts, src/check.ts,
// src/dossier.ts, src/show.ts, src/save.ts, src/changes.ts, src/timeline.ts,
// src/hook.ts, src/insights.ts, src/export.ts, src/chat.ts) whose result this file renders,
// as plain text for an agent or as JSON with --json.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMap } from "./build.js";
import { changeMarkdown, computeDiff, formatChange, readGitDiff, recordChange } from "./changes.js";
import { type CheckReport, checkMap, formatIssue } from "./check.js";
import { DOSSIER_BUDGET, renderNodeDossier } from "./dossier.js";
import { codeindex, indexExists, ULTRAINDEX_VERSION } from "./engine.js";
import { EXPORT_LEVELS, type ExportLevel, exportBrief, exportMermaid, exportSvg, exportView } from "./export.js";
import { type HookResult, installHook, uninstallHook } from "./hook.js";
import { insightsOf } from "./insights.js";
import { writeFileAtomic } from "./json.js";
import { latestChange } from "./model/load.js";
import { TIMELINE_SOURCES, type TimelineItem, type TimelineSource } from "./model/types.js";
import type { Problem } from "./model/validate.js";
import { viewPaths } from "./paths.js";
import { type SaveResult, saveFlow, saveLens } from "./save.js";
import { openFile, renderMap } from "./render.js";
// --- serve / lens new / lens list (issue #10) ---
import { ASK_MODES, type AskMode, askModelProblem } from "./ask.js";
import { EXPLAIN_MODES, type ExplainMode, explainContext, explainNode, formatExplanation, LANG_RE } from "./explain.js";
import { formatLensList, LENS_BUDGET, lensList, lensNew, proposeLensId } from "./lens.js";
import { chatList, chatNew, checkContext, formatChatList, formatConversation, loadConversation, promoteTurn, saveTurn, staleTurns } from "./chat.js";
import { isLoopbackHost, SERVE_HOST, SERVE_PORT, startServe } from "./serve.js";
// --- end serve / lens ---
import { formatNodeCard, liveView, nodeCard, similarIds } from "./show.js";
import { formatBuildSummary } from "./summary.js";
import { readStatus, type StatusReport } from "./status.js";
import { addTimelineEntry, itemsFromFlags, parseItems } from "./timeline.js";
import { ULTRAVIEW_VERSION } from "./version.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const HELP = `ultraview v${ULTRAVIEW_VERSION} (ultraindex ${ULTRAINDEX_VERSION}, codeindex ${codeindex.ENGINE_VERSION})
See your app instead of reading its code: a cited map of a repository, built
from the ultraindex index plus deterministic extractors (routes, data models,
…) and the meaning the agent writes into .ultraview/ (model, flows, lenses),
plus the history of every change (diff, timeline) and engine insights,
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
                     ready, with a worklist (stale lenses, conversation
                     turns, flows).
  check              The gate for what the agent wrote: schema, node ids that
                     resolve, citations that resolve (ultraindex
                     checkCitations), one citation per sentence, coverage
                     (systems >= 90% of code files, capabilities >= 70% of
                     non-test modules), stale lenses / flows / conversation
                     turns (warnings).
                     Exit 1 on failure.
  dossier <node-id>  Evidence pack to write about one node: real source,
                     facts with file:line, neighbours. Cut to --budget tokens.
  show <node-id>     Compact card for one node: kind, label, parent,
                     capabilities, summary, citations, metrics, top edges.
  explain <node-id>  Instant answer about one node, without an agent: its
                     checked prose (summary, tour, flow steps), its facts and
                     its neighbours (callers, callees, data read / written,
                     routes, externals), every sentence cited. --mode business
                     (plain words, default) or dev (symbols, files); --lang
                     picks the templates (en, fr; others fall back to en).
                     "escalate" says the facts are thin: ask the agent.
  lens new "<question>"
                     Evidence pack to answer a question as a lens: the
                     proposed id and target path, the JSON template, candidate
                     nodes (ultraindex find + names matching the question),
                     their strongest edges, source excerpts cut to --budget
                     tokens, then the steps to write and save it.
  lens new "<question>" --thread <id>
                     The same pack for a conversation's next turn: the
                     thread's digest (earlier questions, one-line answers,
                     node ids in play), candidates ranked with the earlier
                     turns' nodes and their neighbours, a turn template
                     (lang, mode, 3 follow-ups) and its draft path.
  lens list          Saved lenses: id, question, node count, stale flag.
  lens save <file>   Validate a lens (one saved question and its cited
                     answer), stamp the hashes of the files it cites, write
                     .ultraview/lenses/<id>.json.
  lens save <file> --thread <id>
                     Validate one turn the same way (plus node ids, every
                     sentence cited, lang, mode, 3 follow-ups) and append it
                     to .ultraview/conversations/<id>.json.
  chat new           Start a conversation (--title): an empty thread in
                     .ultraview/conversations/<id>.json; prints its id.
  chat list          Conversations: id, title, turns, last update, stale turns.
  chat show <id>     One conversation, turn by turn (stale turns flagged).
  chat promote <id> <turn>
                     Save turn <turn> (from 1) of a conversation as a lens
                     (--lens-id <slug>, default: a slug of its question).
  flow save <file>   Same for a flow: .ultraview/flows/<id>.json.
  render             Re-assemble .ultraview/view.json from the current model,
                     flows, lenses, timeline and changes (no re-indexing),
                     embed it into the offline viewer and write one
                     self-contained page, .ultraview/index.html (or --out):
                     the map with semantic zoom, data models, flows, saved
                     questions, changes, search and tour. Notes when the
                     index is stale (run build). --open opens it in the
                     default browser.
  diff               What changed, on the map: the engine's delta mapped onto
                     every level (capabilities, systems, modules, files,
                     symbols, routes, screens, entities, jobs) as added /
                     changed / removed / impacted (blast radius), with
                     per-module risk and imports broken by a removal. Against
                     --base <ref> (default: origin/HEAD, origin/main, main…),
                     --staged (staged vs HEAD) or --worktree (staged, unstaged
                     and untracked vs HEAD). Rebuilds the map first when it is
                     stale. --record writes .ultraview/changes/<id>.json and
                     appends a timeline entry; --markdown prints a PR summary
                     with a Mermaid diagram of the impacted modules.
  timeline add       Append a narrated entry to .ultraview/timeline.jsonl:
                     --title, --summary (every sentence cites [path:line]),
                     optional --request, --source, and items as repeated
                     --ref <node-id> [--change new|changed|removed] [--note …]
                     or --items '<json array>'. Refused when invalid.
  hook install       Opt-in: add a Claude Code Stop hook to
                     <repo>/.claude/settings.local.json (personal, not
                     committed) that records every agent turn (diff --worktree
                     --record, silent, never fails the turn). --shared writes
                     the committed .claude/settings.json instead (warns: the
                     command holds this machine's absolute path). Other keys
                     and hooks are kept; --dry-run shows the file and diff.
  hook uninstall     Remove that hook, and only it, from whichever of the two
                     files holds it.
  insights           Engine-grounded findings: hotspots, hidden coupling,
                     import cycles, dead code, untested hubs, repeated
                     literals; each with a ready prompt for your agent.
  export             The map for a README or PR: --mermaid (flowchart),
                     --svg (laid-out diagram) at --level cap|sys|mod or of one
                     --lens <id> / --flow <id>, or --md (an architecture brief).
                     --out <file> writes it (atomically) instead of printing.
  serve              Local server for the map with live data: the page, its
                     view.json, an event stream that pushes every change
                     under .ultraview/ (and a stale notice when source files
                     change), /api/node, /api/search, /api/callgraph,
                     POST /api/explain (the explain answer), and the
                     optional Ask bridge (POST /api/ask: a read-only run of
                     the claude or codex CLI whose answer is saved as a lens;
                     POST /api/chat: the same for one conversation turn, as
                     an event stream), GET /api/chat, GET /api/chats.
                     Binds ${SERVE_HOST}:${SERVE_PORT}; Ctrl-C stops it.

Options:
  --repo <dir>   Repository to map (default: the current directory)
  --no-ast       build: skip loading the tree-sitter grammars (regex symbols,
                 no network). Grammars are otherwise pulled once per machine
                 into the shared codeindex cache; CODEINDEX_NO_GRAMMARS_PULL=1
                 forbids the download.
  --strict       check: stale lenses / flows / turns fail instead of warning
  --budget <n>   dossier / lens new: token budget (default ${DOSSIER_BUDGET} / ${LENS_BUDGET},
                 ~4 characters a token)
  --id <slug>    lens new: the lens id (default: a slug of the question, or
                 of --terms, or lens-<hash> for a question in another
                 script, made unique against the saved lenses)
  --terms "<w>"  lens new: English code keywords for the question, merged
                 into its reading; required when the question is not in
                 English (its own words then weigh less)
  --thread <id>  lens new / lens save: the conversation the question follows
                 up in (new: its digest and ranking; save: append the turn)
  --context <j>  lens new: what the question is about in the map, as JSON:
                 '{"node":"<id>"}', '{"edge":"<from> -> <to>"}',
                 '{"insight":"<id>"}' or '{"step":"<flow-id>:<n>"}'
  --lens-id <s>  chat promote: the lens id (default: a slug of the question)
  --force        lens save / flow save / chat promote: replace a different
                 question / title saved under the same id
  --open         render / serve: open the page with the OS opener afterwards
  --port <n>     serve: port (default ${SERVE_PORT}; 0 picks a free one)
  --host <addr>  serve: address to bind (default ${SERVE_HOST}). A non-loopback
                 address serves the map to the network: only when asked for
                 explicitly, with a warning
  --ask <agent>  serve: the Ask bridge, ${ASK_MODES.join("|")} (default auto:
                 claude, then codex, if installed; none turns it off)
  --ask-model <m> serve: the model the agent runs for asks and conversation
                 turns (claude --model, codex -m), e.g. sonnet or haiku for
                 faster turns; default: the agent's own
  --mode <m>     explain: business (default) or dev
  --lang <xx>    explain: language of the answer's templates (en default, fr);
                 another tag falls back to en and says so
  --base <ref>   diff: the ref to compare with (its merge-base with HEAD)
  --staged       diff: staged changes only, against HEAD
  --worktree     diff: everything uncommitted, against HEAD
  --depth <n>    diff: blast-radius depth in hops (default 2)
  --record       diff: write the change set and append a timeline entry
  --source <s>   diff --record / timeline add: agent, pr or manual (default:
                 manual for diff, agent for timeline add)
  --title <t>    diff --record / timeline add: entry title (diff: from
                 counts); chat new: the conversation's title
  --summary <s>  diff --record / timeline add: cited summary (diff: an auto
                 summary from counts, flagged auto)
  --request <r>  diff --record / timeline add: what was asked
  --ref <id>     timeline add: an item's node id (repeatable)
  --change <c>   timeline add: the last --ref's change: new, changed (default)
                 or removed
  --note <n>     timeline add: the last --ref's note
  --items <json> timeline add: items as a JSON array of { ref, change, note }
  --markdown     diff: print a PR-ready Markdown summary
  --quiet        diff: print nothing on success
  --hook         diff: hook mode — exit 0 whatever happens, errors to
                 .ultraview/hook.log, skip when nothing new to record
  --agent <a>    hook: the agent to hook (only claude)
  --dry-run      hook: print the settings file and diff, write nothing
  --shared       hook install: .claude/settings.json (committed) instead of
                 .claude/settings.local.json
  --mermaid      export: Mermaid flowchart
  --svg          export: SVG diagram
  --md           export: Markdown architecture brief
  --level <l>    export: cap, sys (default) or mod
  --lens <id>    export: the subgraph of one saved lens
  --flow <id>    export: the steps of one saved flow
  --out <file>   render: where to write the page (default
                 <repo>/.ultraview/index.html); export: write to this file
                 instead of stdout
  --json         Machine-readable output (the full result object)
  -h, --help     Show this help
  -v, --version  Show the version

Exit codes: 0 ok, 1 failure (check failed, save / record / timeline entry
refused), 2 usage error or unknown node id. diff --hook always exits 0.
`;

export const COMMANDS = [
  "build",
  "status",
  "check",
  "dossier",
  "show",
  "lens",
  "flow",
  "render",
  "diff",
  "timeline",
  "hook",
  "insights",
  "export",
  "serve",
  "explain",
  "chat",
];
export const VALUE_FLAGS = [
  "repo",
  "budget",
  "base",
  "depth",
  "source",
  "title",
  "summary",
  "request",
  "ref",
  "change",
  "note",
  "items",
  "agent",
  "level",
  "lens",
  "flow",
  "out",
  "id",
  "terms",
  "port",
  "host",
  "ask",
  "ask-model",
  "mode",
  "lang",
  "thread",
  "context",
  "lens-id",
];
export const BOOL_FLAGS = [
  "json",
  "no-ast",
  "strict",
  "force",
  "staged",
  "worktree",
  "record",
  "markdown",
  "quiet",
  "hook",
  "dry-run",
  "shared",
  "mermaid",
  "md",
  "svg",
  "open",
];

/** Positional arguments each command takes (after the command name). */
const ARITY: Record<string, { min: number; max: number; usage: string }> = {
  build: { min: 0, max: 0, usage: "build" },
  status: { min: 0, max: 0, usage: "status" },
  check: { min: 0, max: 0, usage: "check" },
  dossier: { min: 1, max: 1, usage: "dossier <node-id>" },
  show: { min: 1, max: 1, usage: "show <node-id>" },
  lens: { min: 1, max: 2, usage: 'lens new "<question>" | lens list | lens save <file>' },
  flow: { min: 2, max: 2, usage: "flow save <file>" },
  render: { min: 0, max: 0, usage: "render [--out <file>] [--open]" },
  diff: { min: 0, max: 0, usage: "diff [--base <ref> | --staged | --worktree] [--record] [--markdown]" },
  timeline: { min: 1, max: 1, usage: "timeline add --title … --summary …" },
  hook: { min: 1, max: 1, usage: "hook install|uninstall [--agent claude]" },
  insights: { min: 0, max: 0, usage: "insights" },
  export: { min: 0, max: 0, usage: "export --mermaid|--svg|--md [--level cap|sys|mod] [--lens <id>] [--flow <id>] [--out <file>]" },
  serve: { min: 0, max: 0, usage: "serve [--port <n>] [--host <addr>] [--ask auto|claude|codex|none] [--ask-model <m>] [--open]" },
  explain: { min: 1, max: 1, usage: "explain <node-id> [--mode business|dev] [--lang <xx>]" },
  chat: { min: 1, max: 3, usage: "chat new [--title <t>] | chat list | chat show <id> | chat promote <id> <turn> [--lens-id <slug>]" },
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
  /** Every value flag in command-line order (repeatable flags: `--ref a --change new --ref b`). */
  seq: [string, string][];
  bools: Set<string>;
  positional: string[];
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): Parsed | { error: string } {
  const parsed: Parsed = { values: {}, seq: [], bools: new Set(), positional: [], help: false, version: false };
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
      parsed.seq.push([key, value]);
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

async function cmdExplain(p: Parsed, io: Io): Promise<number> {
  const id = p.positional[0] as string;
  const mode = p.values.mode ?? "business";
  if (!(EXPLAIN_MODES as readonly string[]).includes(mode)) return usage(io, `--mode must be one of ${EXPLAIN_MODES.join(", ")} (got ${mode})`);
  const lang = p.values.lang;
  if (lang !== undefined && !LANG_RE.test(lang)) return usage(io, `--lang must be a language tag such as en, fr or pt-BR (got ${lang})`);
  const live = liveView(p.values.repo ?? ".");
  const x = explainNode(explainContext(live), id, { mode: mode as ExplainMode, lang });
  if (!x) return unknownId(p, io, id, similarIds(live.view, id));
  io.out(p.bools.has("json") ? json(x) : formatExplanation(x));
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
    if (r.stale) io.out("note       the index is stale: source files changed since the last build; run `ultraview build` to map them\n");
    if (opened === false) io.out("open       no opener found: open the file in a browser\n");
    else if (!opened) io.out("next step: open it in a browser (offline, one file), or pass --open\n");
  }
  return EXIT_OK;
}

function usage(io: Io, message: string): number {
  io.err(`ultraview: ${message}\n`);
  return EXIT_USAGE;
}

const problemLines = (errors: readonly Problem[]) => errors.map((e) => `  ${e.path || "(root)"}: ${e.message}`).join("\n");

/** `--source`, checked; undefined when absent. */
function sourceOf(p: Parsed): TimelineSource | undefined | { error: string } {
  const v = p.values.source;
  if (v === undefined) return undefined;
  return (TIMELINE_SOURCES as readonly string[]).includes(v)
    ? (v as TimelineSource)
    : { error: `--source must be one of ${TIMELINE_SOURCES.join(", ")} (got ${v})` };
}

async function runDiff(p: Parsed, io: Io, repo: string, hook: boolean): Promise<number> {
  const { staged, worktree } = { staged: p.bools.has("staged"), worktree: p.bools.has("worktree") };
  if (staged && worktree) return usage(io, "--staged and --worktree are exclusive");
  if (p.values.base !== undefined && (staged || worktree)) return usage(io, "--base compares committed work with a branch: drop --staged / --worktree");
  let depth: number | undefined;
  if (p.values.depth !== undefined) {
    depth = Number(p.values.depth);
    if (!Number.isInteger(depth) || depth < 0) return usage(io, `--depth must be a non-negative integer (got ${p.values.depth})`);
  }
  const source = sourceOf(p);
  if (source && typeof source === "object") return usage(io, source.error);
  const record = p.bools.has("record");
  const quiet = p.bools.has("quiet");
  const asJson = p.bools.has("json");
  if (hook && !indexExists(viewPaths(repo).index)) {
    io.err("no ultraindex index: run `ultraview build` once, the hook then keeps the timeline\n");
    return EXIT_FAILURE;
  }
  const opts = { base: p.values.base, staged, worktree, depth, ast: !p.bools.has("no-ast") };
  const git = readGitDiff(repo, opts);
  if (record) {
    // Nothing (new) to record: an empty diff, or the same one as the last change set.
    const last = latestChange(repo);
    const skipped = !git.diff.files.length ? "nothing changed" : last?.fingerprint === git.fingerprint ? `already recorded as ${last.id}` : undefined;
    if (skipped) {
      if (asJson) io.out(json({ recorded: false, reason: skipped }));
      else if (!quiet) io.out(`diff       ${skipped}: nothing recorded\n`);
      return EXIT_OK;
    }
  }
  const { change, view } = await computeDiff(repo, opts, git);
  let recorded: ReturnType<typeof recordChange> | undefined;
  if (record) {
    recorded = recordChange(repo, change, {
      source: source ?? (hook ? "agent" : "manual"),
      title: p.values.title,
      summary: p.values.summary,
      request: p.values.request,
    });
    if (!recorded.ok) {
      if (asJson) io.out(json({ recorded: false, errors: recorded.errors }));
      io.err(`ultraview: change not recorded:\n${problemLines(recorded.errors)}\n`);
      return EXIT_FAILURE;
    }
  }
  if (quiet) return EXIT_OK;
  if (asJson)
    io.out(json(recorded ? { change: { ...change, id: recorded.entry!.change }, recorded: true, file: recorded.file, entry: recorded.entry } : { change }));
  else if (p.bools.has("markdown")) io.out(changeMarkdown(change, view));
  else io.out(`${formatChange(change)}${recorded ? `recorded   ${recorded.file}; timeline entry appended\n` : ""}`);
  return EXIT_OK;
}

async function cmdDiff(p: Parsed, io: Io): Promise<number> {
  const repo = resolve(p.values.repo ?? ".");
  if (!p.bools.has("hook")) return runDiff(p, io, repo, false);
  // Hook mode: never a word on stdout, never a failing exit; problems go to .ultraview/hook.log.
  // A refresh inside an agent's turn uses cached grammars or the regex tier, never the network.
  const pull = process.env.CODEINDEX_NO_GRAMMARS_PULL;
  process.env.CODEINDEX_NO_GRAMMARS_PULL = "1";
  const errs: string[] = [];
  try {
    await runDiff(p, { out: () => {}, err: (s) => void errs.push(s) }, repo, true);
  } catch (e) {
    errs.push(`${(e as Error).message}\n`);
  } finally {
    if (pull === undefined) delete process.env.CODEINDEX_NO_GRAMMARS_PULL;
    else process.env.CODEINDEX_NO_GRAMMARS_PULL = pull;
  }
  if (errs.length) {
    try {
      const log = viewPaths(repo).hookLog;
      if (!existsSync(viewPaths(repo).dir)) mkdirSync(viewPaths(repo).dir, { recursive: true });
      appendFileSync(log, errs.map((e) => `${new Date().toISOString()} ${e.replace(/^ultraview: /, "")}`).join(""));
    } catch {
      // Nowhere to log: still never fail the agent's turn.
    }
  }
  return EXIT_OK;
}

async function cmdTimeline(p: Parsed, io: Io): Promise<number> {
  if (p.positional[0] !== "add") return usage(io, `unknown timeline action: ${p.positional[0]} (only \`timeline add\`)`);
  if (p.values.title === undefined || p.values.summary === undefined) return usage(io, "timeline add needs --title and --summary");
  const source = sourceOf(p);
  if (source && typeof source === "object") return usage(io, source.error);
  const items: TimelineItem[] = [];
  const problems: Problem[] = [];
  if (p.values.items !== undefined) {
    const r = parseItems(p.values.items);
    items.push(...r.items);
    problems.push(...r.problems);
  }
  const flagged = itemsFromFlags(p.seq);
  items.push(...flagged.items);
  problems.push(...flagged.problems);
  const r = problems.length
    ? { ok: false, file: ".ultraview/timeline.jsonl", errors: problems }
    : addTimelineEntry(p.values.repo ?? ".", { title: p.values.title, summary: p.values.summary, request: p.values.request, source, items });
  if (p.bools.has("json")) io.out(json(r));
  else if (r.ok) io.out(`appended   ${r.file} (${items.length} item(s))\n`);
  else io.err(`ultraview: timeline entry not appended:\n${problemLines(r.errors)}\n`);
  return r.ok ? EXIT_OK : EXIT_FAILURE;
}

/** The ultraview.mjs this process runs (the bundle when run as the skill). */
function scriptPath(): string {
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(self);
  } catch {
    return self;
  }
}

async function cmdHook(p: Parsed, io: Io): Promise<number> {
  const action = p.positional[0];
  if (action !== "install" && action !== "uninstall") return usage(io, `unknown hook action: ${action} (install or uninstall)`);
  const repo = p.values.repo ?? ".";
  const opts = { agent: p.values.agent, dryRun: p.bools.has("dry-run"), shared: p.bools.has("shared") };
  const r: HookResult = action === "install" ? installHook(repo, scriptPath(), opts) : uninstallHook(repo, opts);
  if (p.bools.has("json")) io.out(json(r));
  else if (!r.ok) io.err(`ultraview: ${r.errors.join("; ")}\n`);
  else {
    const verb = { installed: "installed", updated: "updated", unchanged: "already installed", removed: "removed", absent: "not installed" }[r.action];
    io.out(
      `hook       ${r.dryRun ? "(dry run) would be " : ""}${verb}: ${r.files.length ? r.files.join(", ") : r.file}${r.command ? `\ncommand    ${r.command}` : ""}\n${r.dryRun && r.diff ? r.diff : ""}`,
    );
  }
  if (r.warning) io.err(`ultraview: warning: ${r.warning}\n`);
  return r.ok ? EXIT_OK : EXIT_FAILURE;
}

async function cmdInsights(p: Parsed, io: Io): Promise<number> {
  const insights = insightsOf(p.values.repo ?? ".");
  if (p.bools.has("json")) io.out(json(insights));
  else if (!insights.length) io.out("insights   none: no hotspot, hidden coupling, cycle, dead code, untested hub or repeated literal past the thresholds\n");
  else {
    const lines = [`insights   ${insights.length}`];
    for (const i of insights) lines.push(`  [${i.severity}] ${i.kind}  ${i.title}`, `      ${i.detail}`, `      prompt: ${i.prompt}`);
    io.out(`${lines.join("\n")}\n`);
  }
  return EXIT_OK;
}

async function cmdExport(p: Parsed, io: Io): Promise<number> {
  const formats = (["mermaid", "svg", "md"] as const).filter((f) => p.bools.has(f));
  if (formats.length !== 1) return usage(io, "export needs exactly one of --mermaid, --svg, --md");
  const format = formats[0]!;
  const picks = (["level", "lens", "flow"] as const).filter((k) => p.values[k] !== undefined);
  if (picks.length > 1) return usage(io, "use one of --level, --lens, --flow");
  if (format === "md" && picks.length) return usage(io, "--md is the whole brief: --level / --lens / --flow are for --mermaid and --svg");
  const level = p.values.level;
  if (level !== undefined && !(EXPORT_LEVELS as readonly string[]).includes(level))
    return usage(io, `--level must be one of ${EXPORT_LEVELS.join(", ")} (got ${level})`);
  const view = exportView(p.values.repo ?? ".", { insights: format === "md" });
  const opts = { level: level as ExportLevel | undefined, lens: p.values.lens, flow: p.values.flow };
  const content = format === "md" ? exportBrief(view) : format === "svg" ? exportSvg(view, opts) : exportMermaid(view, opts);
  if (p.values.out !== undefined) {
    writeFileAtomic(p.values.out, content);
    io.out(p.bools.has("json") ? json({ format, file: resolve(p.values.out) }) : `wrote      ${p.values.out}\n`);
  } else io.out(p.bools.has("json") ? json({ format, content }) : content);
  return EXIT_OK;
}

// --- serve / lens new / lens list (issue #10) ---

function positiveInt(p: Parsed, io: Io, flag: string): number | undefined | null {
  const raw = p.values[flag];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    io.err(`ultraview: --${flag} must be a positive integer (got ${raw})\n`);
    return null;
  }
  return n;
}

async function cmdLens(p: Parsed, io: Io): Promise<number> {
  const [action, arg] = p.positional as [string, string | undefined];
  const repo = p.values.repo ?? ".";
  if (action === "new") {
    if (arg === undefined) {
      io.err('ultraview: missing argument (usage: ultraview lens new "<question>")\n');
      return EXIT_USAGE;
    }
    const budget = positiveInt(p, io, "budget");
    if (budget === null) return EXIT_USAGE;
    let context: ReturnType<typeof checkContext> | undefined;
    if (p.values.context !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(p.values.context);
      } catch {
        return usage(io, `--context must be JSON, e.g. '{"node":"entity:Order"}' (got ${p.values.context})`);
      }
      context = checkContext(raw);
      if ("error" in context) return usage(io, `--context: ${context.error}`);
    }
    const pack = lensNew(repo, arg, {
      budget,
      id: p.values.id,
      terms: p.values.terms,
      ...(p.values.thread !== undefined ? { thread: p.values.thread } : {}),
      ...(context ? { context: context as Exclude<typeof context, { error: string }> } : {}),
    });
    io.out(p.bools.has("json") ? json(pack) : pack.text);
    return EXIT_OK;
  }
  if (action === "list") {
    if (arg !== undefined) {
      io.err(`ultraview: unexpected argument: ${arg} (usage: ultraview lens list)\n`);
      return EXIT_USAGE;
    }
    const r = lensList(repo);
    io.out(p.bools.has("json") ? json(r) : formatLensList(r));
    return EXIT_OK;
  }
  if (action === "save") {
    if (arg === undefined) {
      io.err("ultraview: missing argument (usage: ultraview lens save <file>)\n");
      return EXIT_USAGE;
    }
    if (p.values.thread !== undefined) return cmdSaveTurn(p, io, arg, p.values.thread);
    return cmdSave(p, io, "lens");
  }
  io.err(`ultraview: unknown lens action: ${action} (lens new "<question>", lens list, lens save <file>)\n`);
  return EXIT_USAGE;
}

async function cmdSaveTurn(p: Parsed, io: Io, file: string, thread: string): Promise<number> {
  let text: string;
  try {
    text = readFileSync(resolve(file), "utf8");
  } catch (e) {
    io.err(`ultraview: cannot read ${file}: ${(e as Error).message}\n`);
    return EXIT_FAILURE;
  }
  const r = saveTurn(p.values.repo ?? ".", text, { thread });
  if (p.bools.has("json")) io.out(json(r));
  else if (r.ok)
    io.out(
      `saved      turn ${r.index + 1} of ${r.file}; sources: ${Object.keys(r.turn!.sources).length} cited file(s) hashed\nopen       #chat=${r.thread} (live when \`ultraview serve\` runs)\nnext step: run \`ultraview check\`\n`,
    );
  else io.err(`ultraview: turn not saved (${r.file}):\n${problemLines(r.errors)}\n`);
  return r.ok ? EXIT_OK : EXIT_FAILURE;
}

async function cmdChat(p: Parsed, io: Io): Promise<number> {
  const [action, id, turn] = p.positional as [string, string | undefined, string | undefined];
  const repo = p.values.repo ?? ".";
  const asJson = p.bools.has("json");
  const extra = (n: number) => p.positional.length > n;
  if (action === "new") {
    if (extra(1)) return usage(io, `unexpected argument: ${p.positional[1]} (usage: ultraview chat new [--title <t>])`);
    const c = chatNew(repo, { title: p.values.title });
    io.out(
      asJson
        ? json(c)
        : `created    .ultraview/conversations/${c.id}.json ("${c.title}")\nthread     ${c.id}\nnext step: \`ultraview lens new "<question>" --thread ${c.id}\`\n`,
    );
    return EXIT_OK;
  }
  if (action === "list") {
    if (extra(1)) return usage(io, `unexpected argument: ${p.positional[1]} (usage: ultraview chat list)`);
    const r = chatList(repo);
    io.out(asJson ? json(r) : formatChatList(r));
    return EXIT_OK;
  }
  if (action === "show") {
    if (id === undefined || extra(2)) return usage(io, "usage: ultraview chat show <id>");
    const c = loadConversation(repo, id);
    const stale = staleTurns(repo, c);
    io.out(asJson ? json({ ...c, stale }) : formatConversation(c, stale));
    return EXIT_OK;
  }
  if (action === "promote") {
    if (id === undefined || turn === undefined) return usage(io, "usage: ultraview chat promote <id> <turn> [--lens-id <slug>]");
    const n = Number(turn);
    if (!Number.isInteger(n) || n < 1) return usage(io, `<turn> must be a turn number from 1 (got ${turn})`);
    const r = promoteTurn(repo, id, n, { lensId: p.values["lens-id"], force: p.bools.has("force"), proposeId: (q) => proposeLensId(repo, q).id });
    if (asJson) io.out(json(r));
    else if (r.ok)
      io.out(`saved      ${r.file}${r.replaced ? " (replaced)" : ""} from turn ${n} of ${id}\nopen       #lens=${r.id}\nnext step: run \`ultraview check\`\n`);
    else io.err(`ultraview: lens not saved${r.file ? ` (${r.file})` : ""}:\n${problemLines(r.errors)}\n`);
    return r.ok ? EXIT_OK : EXIT_FAILURE;
  }
  return usage(io, `unknown chat action: ${action} (chat new, chat list, chat show <id>, chat promote <id> <turn>)`);
}

async function cmdServe(p: Parsed, io: Io): Promise<number> {
  const ask = (p.values.ask ?? "auto") as AskMode;
  if (!(ASK_MODES as readonly string[]).includes(ask)) {
    io.err(`ultraview: --ask must be one of ${ASK_MODES.join(", ")} (got ${ask})\n`);
    return EXIT_USAGE;
  }
  let port = SERVE_PORT;
  if (p.values.port !== undefined) {
    port = Number(p.values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      io.err(`ultraview: --port must be 0-65535 (got ${p.values.port})\n`);
      return EXIT_USAGE;
    }
  }
  const askModel = p.values["ask-model"];
  const modelError = askModel !== undefined ? askModelProblem(askModel) : undefined;
  if (modelError) return usage(io, modelError);
  const host = p.values.host;
  const handle = await startServe({
    repo: p.values.repo ?? ".",
    port,
    host,
    hostExplicit: host !== undefined,
    ask,
    ...(askModel !== undefined ? { askModel } : {}),
    onWarning: (m) => io.err(`ultraview: ${m}\n`),
  });
  if (!isLoopbackHost(handle.host))
    io.err(
      `ultraview: WARNING: serving on ${handle.host}, beyond this machine: anyone who can reach port ${handle.port} reads the map and its source excerpts (asking stays local-only)\n`,
    );
  const opened = p.bools.has("open") ? await openFile(handle.url) : undefined;
  if (p.bools.has("json"))
    io.out(
      json({
        url: handle.url,
        host: handle.host,
        port: handle.port,
        repo: handle.repo,
        ask: handle.ask ?? null,
        ...(handle.askModel ? { askModel: handle.askModel } : {}),
        ...(opened !== undefined ? { opened } : {}),
      }),
    );
  else {
    io.out(`serving    ${handle.url}  (live: every change under .ultraview/ shows up without a reload)\n`);
    io.out(
      `ask        ${handle.ask ? `${handle.ask.name} (${handle.ask.path})${handle.askModel ? `, model ${handle.askModel}` : ""}, read-only; answers saved as lenses and conversation turns` : ask === "none" ? "off (--ask none)" : "off: neither claude nor codex found on PATH"}\n`,
    );
    if (opened === false) io.out("open       no opener found: open the address in a browser\n");
    io.out("stop       Ctrl-C\n");
  }
  const stop = () => void handle.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await handle.closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  return EXIT_OK;
}

// --- end serve / lens ---

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
      case "explain":
        return await cmdExplain(p, io);
      case "lens":
        return await cmdLens(p, io);
      case "flow":
        return await cmdSave(p, io, p.command);
      case "render":
        return await cmdRender(p, io);
      case "diff":
        return await cmdDiff(p, io);
      case "timeline":
        return await cmdTimeline(p, io);
      case "hook":
        return await cmdHook(p, io);
      case "insights":
        return await cmdInsights(p, io);
      case "export":
        return await cmdExport(p, io);
      case "serve":
        return await cmdServe(p, io);
      case "chat":
        return await cmdChat(p, io);
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
