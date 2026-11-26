// The Ask bridge behind `ultraview serve --ask` (docs/design.md §7): one
// question from the viewer → one read-only, non-interactive run of the user's
// coding agent CLI → one lens (`POST /api/ask`) or one conversation turn
// (`POST /api/chat`, src/chat.ts), validated and saved by ultraview itself.
//
//   - The agent is found on PATH (`auto`: claude, then codex) and spawned by
//     absolute path, with a minimal environment, the repository as its working
//     directory, the prompt on stdin (never in argv, so never in `ps`).
//   - It runs read-only: Claude Code with `--permission-mode dontAsk`, only the
//     Bash / Read / Glob / Grep tools, and Bash allowed for ultraview's read-only
//     commands only; Codex with `--sandbox read-only`. No flag that bypasses
//     permissions is ever passed.
//   - A turn's prompt carries the thread's digest (chatDigest), what the
//     question was asked about in the map, the mode (business: plain words;
//     dev: symbols, calls, files) and the rule to answer in the question's
//     language with 3 follow-ups; the agent runs `lens new --thread`.
//   - It writes nothing: its final message is the lens JSON. ultraview takes it
//     (Claude: stdout; Codex: `--output-last-message` into a private temp dir),
//     forces the proposed id and the asked question, and runs `saveLens`, which
//     validates the schema, checks every citation and stamps `sources`.
//   - Everything the agent prints is appended to `.ultraview/ask.log` (gitignored).
//
// Never prints, never exits.

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_QUESTION_MAX, type ContextView, chatDigest, resolveContext, saveTurn, type TurnResult } from "./chat.js";
import { proposeLensId } from "./lens.js";
import type { ChatContext, ChatMode, ChatTurn, Conversation } from "./model/types.js";
import type { Problem } from "./model/validate.js";
import { VIEW_DIR } from "./paths.js";
import { saveLens } from "./save.js";

export const ASK_AGENTS = ["claude", "codex"] as const;
export type AskAgentName = (typeof ASK_AGENTS)[number];
export const ASK_MODES = ["auto", ...ASK_AGENTS, "none"] as const;
export type AskMode = (typeof ASK_MODES)[number];

/** Default time an ask may take, in milliseconds. */
export const ASK_TIMEOUT_MS = 180_000;
/** Longest question accepted. */
export const ASK_QUESTION_MAX = CHAT_QUESTION_MAX;
/** Agent output kept in memory to read the answer from (the log gets everything). */
const OUTPUT_MAX = 4 * 1024 * 1024;
export const ASK_LOG = `${VIEW_DIR}/ask.log`;
/**
 * A model name `--ask-model` accepts (`sonnet`, `claude-haiku-4-5`, `gpt-5-codex`,
 * `opus[1m]`): starts with a letter or digit, so it can never read as a flag.
 */
export const ASK_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;

/** Why `model` is refused as `--ask-model`, or undefined when it is fine. */
export function askModelProblem(model: string): string | undefined {
  return ASK_MODEL_RE.test(model)
    ? undefined
    : `--ask-model must be a model name (letters, digits and . _ : / @ [ ] -, at most 100), got ${JSON.stringify(model)}`;
}

export interface AskAgent {
  name: AskAgentName;
  /** Absolute path of the executable. */
  path: string;
}

/** The absolute path of `name` on `pathEnv`, or undefined. */
export function findOnPath(name: string, pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  const exts = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (pathEnv ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const abs = join(dir, name + ext);
      try {
        if (!statSync(abs).isFile()) continue;
        if (platform !== "win32") accessSync(abs, constants.X_OK);
        return abs;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** The agent `mode` resolves to on `pathEnv`; undefined for `none` or when nothing is installed. */
export function resolveAskAgent(mode: AskMode, pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): AskAgent | undefined {
  if (mode === "none") return undefined;
  const names: readonly AskAgentName[] = mode === "auto" ? ASK_AGENTS : [mode];
  for (const name of names) {
    const path = findOnPath(name, pathEnv, platform);
    if (path) return { name, path };
  }
  return undefined;
}

/** Where the runnable ultraview bundle is: this file when bundled, else the repo's scripts/ultraview.mjs. */
export function ultraviewScript(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".mjs")) return here;
  return resolve(dirname(here), "../scripts/ultraview.mjs");
}

/** The ultraview command line the agent runs (quoted when the path needs it). */
function scriptCommand(script: string): string {
  return /^[A-Za-z0-9_./:\\-]+$/.test(script) ? `node ${script}` : `node "${script}"`;
}

/** ultraview subcommands the agent may run: all read-only. */
const READ_ONLY_COMMANDS = ["lens new", "lens list", "show", "dossier", "status", "check"];

/** The prompt handed to the agent on stdin. */
export function askPrompt(question: string, id: string, script: string): string {
  const uv = scriptCommand(script);
  return [
    "You answer one question about the repository in the current directory for ultraview, a cited map of the app.",
    "You are read-only: never create, edit, move or delete any file, and never run a command that writes. ultraview saves your answer itself.",
    "",
    `Question: ${question}`,
    "",
    "Steps:",
    `1. Gather the evidence with ultraview: ${uv} lens new ${JSON.stringify(question)} --id ${id}`,
    "   It prints candidate nodes, their edges, source excerpts and the JSON template to fill.",
    '   If the question is not in English, you MUST add --terms "<English code keywords>" to that command: 3-8 words the code',
    "   would use for what is asked (e.g. order cancel delete), plus this repository's own names when you know them. Keep the",
    "   question exactly as asked; the terms carry the search.",
    `2. Read more source if you need to (Read, Grep, Glob; or ${uv} show <node-id> and ${uv} dossier <node-id>).`,
    "3. Reply with ONLY the lens JSON object (no prose before or after it), filled in from the template:",
    `   {"schema": 1, "id": "${id}", "question": ${JSON.stringify(question)}, "answer": "...", "nodes": [...], "edges": [...], "focus": "..."}`,
    "   - answer: Markdown in plain words; EVERY sentence ends with the citation it rests on, as [path:line] or [path:start-end], a file of this repository.",
    "   - nodes: the node ids the answer is about (from the candidates, or ids ultraview show knows); edges: optional links between them; focus: one of the nodes.",
    "   - Leave out sources. Do not write the JSON to a file and do not run lens save: ultraview validates and saves your reply.",
    "",
  ].join("\n");
}

/** A shell-safe single-quoted argument. */
const shellQuote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

export interface ChatPromptInput {
  question: string;
  mode: ChatMode;
  /** The conversation so far (absent for a first turn). */
  thread?: Conversation;
  /** What the question was asked about, and the lines saying so. */
  context?: { value: ChatContext; lines: string[] };
}

/**
 * The prompt for one conversation turn: the thread's digest (turns 1..N-1:
 * questions, one-line answers, node ids in play), what was clicked, the
 * mode's register, the language rule and the turn JSON to reply with.
 */
export function chatPrompt(input: ChatPromptInput, script: string): string {
  const uv = scriptCommand(script);
  const { question, mode, thread, context } = input;
  const flags = [
    ...(thread ? [`--thread ${thread.id}`] : []),
    ...(context && Object.keys(context.value).length ? [`--context ${shellQuote(JSON.stringify(context.value))}`] : []),
  ].join(" ");
  const digest = thread ? chatDigest(thread) : "";
  const register =
    mode === "business"
      ? "Mode business: the reader does not read code. Use plain business words (what the app does for whom); do not name functions, files, symbols or routes unless the question asks for them (citations still name files)."
      : "Mode dev: the reader is a developer. Give the technical detail: the symbols, the calls between them, the files, routes and data they touch.";
  return [
    "You answer one turn of a conversation about the repository in the current directory for ultraview, a cited map of the app.",
    "You are read-only: never create, edit, move or delete any file, and never run a command that writes. ultraview saves your answer itself.",
    "",
    ...(digest
      ? [
          digest,
          "",
          `Read the question with the conversation above: "it", "that", "this", "and then?" refer to the most recent turn's nodes unless the question names something else.`,
          "",
        ]
      : []),
    ...(context
      ? [`The user asked from the map, about: ${context.lines.join("; ")}. "This" and "it" mean that, unless the question names something else.`, ""]
      : []),
    `Question: ${question}`,
    "",
    register,
    "Answer in the language of the question (a French question gets a French answer, a Japanese one a Japanese answer); citations stay [path:line].",
    "",
    "Steps:",
    // Single-quoted: nothing in the question ($, backticks) is expanded by the shell the agent runs it in.
    `1. Gather the evidence with ultraview: ${uv} lens new ${shellQuote(question)}${flags ? ` ${flags}` : ""}`,
    "   It prints the conversation so far, candidate nodes (those the conversation points at among them), their edges, source excerpts and the JSON template to fill.",
    '   If the question is not in English, you MUST add --terms "<English code keywords>" to that command: 3-8 words the code would use for what is',
    "   asked, including what its pronouns refer to in the conversation (e.g. order cancel delete), plus this repository's own names when you know them.",
    "   Keep the question exactly as asked; the terms carry the search.",
    `2. Read more source if you need to (Read, Grep, Glob; or ${uv} show <node-id> and ${uv} dossier <node-id>).`,
    "3. Reply with ONLY the turn JSON object (no prose before or after it):",
    `   {"question": ${JSON.stringify(question)}, "answer": "...", "nodes": [...], "edges": [...], "focus": "...", "lang": "<the question's language: en, fr, ja...>", "followUps": ["...", "...", "..."]}`,
    "   - answer: Markdown, in the question's language; EVERY sentence ends with the citation it rests on, as [path:line] or [path:start-end], a file of this repository.",
    "   - nodes: the node ids the answer is about (from the candidates, or ids ultraview show knows); edges: optional links between them; focus: one of the nodes.",
    "   - followUps: exactly 3 short questions the user could ask next about this app, in the question's language.",
    "   - Do not write the JSON to a file and do not run lens save: ultraview validates and saves your reply.",
    "",
  ].join("\n");
}

export interface AgentInvocation {
  cmd: string;
  args: string[];
  /** Codex: where its last message lands. */
  lastMessageFile?: string;
}

/**
 * The command line for one ask. Claude Code: print mode, `dontAsk` (anything
 * not allowed below is denied without a prompt), only the read tools plus
 * Bash, and Bash only for ultraview's read-only commands. Codex: `exec` in the
 * read-only sandbox, nothing persisted, the last message into `tmpDir`.
 * `model` (`serve --ask-model`, checked by `askModelProblem`) is passed as
 * Claude's `--model` / Codex's `-m`; without it the agent's default runs.
 */
export function agentInvocation(agent: AskAgent, ctx: { script: string; repo: string; tmpDir: string; model?: string }): AgentInvocation {
  const model = ctx.model;
  const uv = scriptCommand(ctx.script);
  if (agent.name === "claude") {
    return {
      cmd: agent.path,
      args: [
        "-p",
        "--output-format",
        "text",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "Bash,Read,Glob,Grep",
        "--allowedTools",
        // Prefix rules: `Bash(<command>:*)` allows that command with any arguments, nothing else.
        ...READ_ONLY_COMMANDS.map((c) => `Bash(${uv} ${c}:*)`),
        "Read",
        "Glob",
        "Grep",
        "--disallowedTools",
        "Write",
        "Edit",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        ...(model ? ["--model", model] : []),
      ],
    };
  }
  const lastMessageFile = join(ctx.tmpDir, "last-message.txt");
  return {
    cmd: agent.path,
    args: [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      ctx.repo,
      "--output-last-message",
      lastMessageFile,
      ...(model ? ["-m", model] : []),
      "-",
    ],
    lastMessageFile,
  };
}

/** Variables passed through to the agent; everything else in the server's environment stays out. */
const ENV_KEEP = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "CODEINDEX_NO_GRAMMARS_PULL",
];
/** Prefixes of the agents' own configuration and credentials. */
const ENV_KEEP_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_"];

/** The minimal environment the agent runs with. */
export function agentEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (ENV_KEEP.includes(k) || ENV_KEEP_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  env.NO_COLOR = "1";
  return env;
}

/** The lens object in an agent's reply: the whole text, a fenced block, or the outermost `{…}`. */
export function extractLensJson(text: string): Record<string, unknown> | undefined {
  const tries: string[] = [text.trim()];
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
  if (fence) tries.push(fence[1]!.trim());
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a !== -1 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // next
    }
  }
  return undefined;
}

export type AskStage = "started" | "running" | "validating";

export interface AskRequest {
  repo: string;
  question: string;
  agent: AskAgent;
  /** The model the agent runs (`serve --ask-model`); the agent's default when absent. */
  model?: string;
  /** The server's environment (filtered by agentEnv). */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onProgress?: (stage: AskStage, detail: { bytes?: number }) => void;
  /** Registers the running child, so a shutdown can stop it. */
  onChild?: (child: ChildProcess | undefined) => void;
}

export interface AskOutcome {
  ok: boolean;
  id: string;
  question: string;
  file?: string;
  replaced?: boolean;
  sources?: Record<string, string>;
  error?: string;
  problems?: Problem[];
}

/** The validated question, or the reason it is refused. */
export function checkQuestion(q: unknown): { question: string } | { error: string } {
  if (typeof q !== "string") return { error: "`question` must be a string" };
  const question = q.replace(/\s+/g, " ").trim();
  if (!question) return { error: "`question` is empty" };
  if (question.length > ASK_QUESTION_MAX) return { error: `\`question\` is longer than ${ASK_QUESTION_MAX} characters` };
  return { question };
}

/** The id an ask will save under (proposed before the agent runs, so every event names it). */
export function askLensId(repo: string, question: string): string {
  return proposeLensId(repo, question).id;
}

/**
 * `.ultraview/ask.log`, appended synchronously: every line is on disk, in
 * order, when `write` returns, so the log is complete before an ask's outcome
 * is announced. A log that cannot be opened or written is skipped, never fatal.
 */
function openAskLog(file: string): { write: (data: string | Buffer) => void; close: () => void } {
  let fd: number | undefined;
  try {
    fd = openSync(file, "a");
  } catch {
    fd = undefined;
  }
  return {
    write(data) {
      if (fd === undefined) return;
      try {
        writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      } catch {
        // a log write never fails the ask
      }
    },
    close() {
      if (fd === undefined) return;
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
      fd = undefined;
    },
  };
}

/** One finished agent run, as the runner reports it: the outcome to log and announce. */
interface RunOutcome {
  ok: boolean;
  file?: string;
  error?: string;
  problems?: Problem[];
}

/**
 * Run the agent once: spawn it read-only with `prompt` on stdin, log
 * everything it prints, enforce the timeout, then hand its reply's JSON object
 * to `accept`, which validates and saves it. `label` heads the log entry.
 * Never throws. (The one place an agent is started: a model choice would be
 * passed through `agentInvocation` here.)
 */
function runAgent<O extends RunOutcome>(
  req: AskRequest,
  label: string,
  prompt: string,
  fail: (error: string, problems?: Problem[]) => O,
  accept: (reply: Record<string, unknown>) => O,
): Promise<O> {
  const repo = resolve(req.repo);
  const { agent } = req;
  const tmpDir = mkdtempSync(join(tmpdir(), "ultraview-ask-"));
  const inv = agentInvocation(agent, { script: ultraviewScript(), repo, tmpDir, ...(req.model ? { model: req.model } : {}) });
  mkdirSync(join(repo, VIEW_DIR), { recursive: true });
  const log = openAskLog(join(repo, ASK_LOG));
  log.write(
    `=== ${new Date().toISOString()} ${label} (${agent.name})\nquestion: ${req.question}\n$ ${[inv.cmd, ...inv.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`,
  );

  return new Promise<O>((done) => {
    let finished = false;
    let out = "";
    let bytes = 0;
    let lastProgress = 0;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (o: O) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      req.onChild?.(undefined);
      // Appended and closed synchronously, so the log is complete before the outcome is announced;
      // `finished` keeps anything the agent prints from now on out of it: this line is the last one.
      log.write(
        `--- ${o.ok ? `saved ${o.file}` : `failed: ${o.error}${o.problems?.length ? `\n${o.problems.map((p) => `  ${p.path || "(root)"}: ${p.message}`).join("\n")}` : ""}`}\n\n`,
      );
      log.close();
      rmSync(tmpDir, { recursive: true, force: true });
      done(o);
    };

    let child: ChildProcess;
    try {
      child = spawn(inv.cmd, inv.args, { cwd: repo, env: agentEnv(req.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      finish(fail(`cannot start ${agent.name}: ${(e as Error).message}`));
      return;
    }
    req.onChild?.(child);
    req.onProgress?.("started", {});
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (finished) return;
      log.write(stream === "stderr" ? `[stderr] ${chunk.toString("utf8")}` : chunk);
      bytes += chunk.length;
      if (stream === "stdout" && out.length < OUTPUT_MAX) out += chunk.toString("utf8");
      const now = Date.now();
      if (now - lastProgress >= 1000) {
        lastProgress = now;
        req.onProgress?.("running", { bytes });
      }
    };
    child.stdout!.on("data", onData("stdout"));
    child.stderr!.on("data", onData("stderr"));
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);
    child.once("error", (e) => finish(fail(`cannot start ${agent.name}: ${e.message}`)));

    const timeoutMs = req.timeoutMs ?? ASK_TIMEOUT_MS;
    timer = setTimeout(() => {
      log.write(`--- timed out after ${Math.round(timeoutMs / 1000)} s: stopping ${agent.name}\n`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      finish(fail(`${agent.name} did not answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);

    child.once("close", (code, signal) => {
      if (finished) return;
      log.write(`\n--- exit ${code ?? signal}\n`);
      if (code !== 0) {
        finish(fail(`${agent.name} exited with ${code ?? signal} (see ${ASK_LOG})`));
        return;
      }
      req.onProgress?.("validating", { bytes });
      let reply = out;
      if (inv.lastMessageFile && existsSync(inv.lastMessageFile)) reply = readFileSync(inv.lastMessageFile, "utf8");
      const json = extractLensJson(reply);
      if (!json) {
        finish(fail(`${agent.name} replied without a JSON object (see ${ASK_LOG})`));
        return;
      }
      let o: O;
      try {
        o = accept(json);
      } catch (e) {
        o = fail((e as Error).message);
      }
      finish(o);
    });
  });
}

/** Run one ask to completion: spawn the agent, read its reply, save the lens. Never throws. */
export function askAgent(req: AskRequest, id: string = askLensId(req.repo, req.question)): Promise<AskOutcome> {
  const repo = resolve(req.repo);
  const { question } = req;
  const base = { id, question };
  return runAgent<AskOutcome>(
    req,
    `ask ${id}`,
    askPrompt(question, id, ultraviewScript()),
    (error, problems) => ({ ...base, ok: false, error, ...(problems ? { problems } : {}) }),
    (lens) => {
      // The id and the question are ultraview's, never the agent's: no overwrite of another saved question.
      const { sources: _ignored, ...rest } = lens;
      const r = saveLens(repo, { schema: 1, ...rest, id, question });
      if (!r.ok) return { ...base, ok: false, error: "the answer did not pass `lens save`", problems: r.errors };
      return { ...base, ok: true, file: r.file, replaced: r.replaced, sources: r.sources };
    },
  );
}

export interface ChatRequest extends AskRequest {
  mode: ChatMode;
  /** The conversation to append to; absent: a new one, `newThread`. */
  thread?: Conversation;
  /** The id a new conversation is created under (proposed before the agent runs). */
  newThread?: string;
  context?: ChatContext;
  /** The map the context and node ids resolve against. */
  view: ContextView;
}

export interface ChatOutcome extends RunOutcome {
  thread: string;
  index?: number;
  turn?: ChatTurn;
}

/** Run one conversation turn to completion: the agent answers with the thread's digest, ultraview validates and appends the turn. Never throws. */
export function chatAgent(req: ChatRequest): Promise<ChatOutcome> {
  const repo = resolve(req.repo);
  const thread = req.thread?.id ?? req.newThread;
  if (!thread) return Promise.resolve({ ok: false, thread: "", error: "internal: no thread id" });
  let context: { value: ChatContext; lines: string[] } | undefined;
  if (req.context && Object.keys(req.context).length) {
    const r = resolveContext(req.view, req.context);
    if ("error" in r) return Promise.resolve({ ok: false, thread, error: r.error });
    context = { value: req.context, lines: r.lines };
  }
  const started = Date.now();
  const prompt = chatPrompt({ question: req.question, mode: req.mode, thread: req.thread, context }, ultraviewScript());
  return runAgent<ChatOutcome>(
    req,
    `chat ${thread} turn ${(req.thread?.turns.length ?? 0) + 1}`,
    prompt,
    (error, problems) => ({ ok: false, thread, error, ...(problems ? { problems } : {}) }),
    (reply) => {
      // The question, the mode and the context are the request's, never the agent's; any id or sources it wrote are dropped.
      const { sources: _s, id: _i, schema: _v, mode: _m, context: _c, ...rest } = reply;
      const r: TurnResult = saveTurn(repo, rest, {
        ...(req.thread ? { thread: req.thread.id } : { create: { id: thread } }),
        question: req.question,
        mode: req.mode,
        ...(req.context && Object.keys(req.context).length ? { context: req.context } : {}),
        source: "agent",
        ms: Date.now() - started,
        view: req.view,
      });
      if (!r.ok) return { ok: false, thread, error: "the answer did not pass the turn's gates (`lens save --thread`)", problems: r.errors };
      return { ok: true, thread, file: r.file, index: r.index, turn: r.turn };
    },
  );
}
