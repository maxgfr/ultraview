// Conversations (docs/design.md §4, §7): a thread of questions about the app,
// each answered like a lens, kept in `.ultraview/conversations/<id>.json` and
// committed like lenses.
//
//   chat new / list / show   create an empty thread, list them, print one
//   saveTurn                 `lens save <file> --thread <id>` and the Ask
//                            bridge's `POST /api/chat`: a lens answer passes
//                            `lens save`'s gates (schema, citations, sources:
//                            src/save.ts `prepareLens`) and `check`'s (node ids
//                            resolve, every sentence cited: src/check.ts
//                            `answerProblems`), plus the turn's own fields
//                            (language, mode, context, 3 follow-ups), then is
//                            appended
//   promoteTurn              `chat promote <id> <turn>`: one turn as a lens
//   chatDigest               the compact memory of turns 1..N-1 a follow-up is
//                            read with (lens new --thread, the agent prompt)
//
// Ids are slugs (SLUG_RE, at most CHAT_ID_MAX characters), so a conversation
// path never leaves its directory. A thread holds at most CHAT_TURNS_MAX turns.
// Never prints, never exits.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { answerProblems } from "./gates.js";
import { codeindex } from "./engine.js";
import { stableJson, writeFileAtomic } from "./json.js";
import { guessLang } from "./lens-terms.js";
import { kindOf, SLUG_RE } from "./model/ids.js";
import { type FileProblem, fileSha256 } from "./model/load.js";
import { splitSentences } from "./model/prose.js";
import {
  CHAT_MODES,
  type ChatContext,
  type ChatMode,
  type ChatTurn,
  type Conversation,
  type Flow,
  type Insight,
  type Lens,
  type TurnSource,
  type ViewNode,
} from "./model/types.js";
import { FOLLOW_UPS, LANG_RE, type Problem, parseJson, validateConversation } from "./model/validate.js";
import { VIEW_DIR, viewPaths } from "./paths.js";
import { carriedOver } from "./refresh.js";
import { prepareLens, type SaveResult, saveLens } from "./save.js";
import { liveView } from "./show.js";

export const CONVERSATIONS_DIR = `${VIEW_DIR}/conversations`;
/** Longest conversation id. */
export const CHAT_ID_MAX = 64;
/** Most turns a conversation holds: past it, start a new one. */
export const CHAT_TURNS_MAX = 40;
/** Longest question a turn holds (the Ask bridge's limit too). */
export const CHAT_QUESTION_MAX = 500;
export const CHAT_TITLE_MAX = 120;
/** Longest follow-up suggestion. */
export const FOLLOW_UP_MAX = 300;
/** Longest context value. */
export const CONTEXT_MAX = 300;
export const DEFAULT_CHAT_TITLE = "Conversation";

/**
 * The digest's budget, in tokens (~4 characters a token: ~1600 characters):
 * the most recent DIGEST_TURNS turns, each a question cut to DIGEST_QUESTION
 * characters, a one-line answer summary cut to DIGEST_SUMMARY, at most
 * DIGEST_NODES node ids; the oldest turns are left out first when the whole is
 * over budget. Bounded whatever the thread's length.
 */
export const DIGEST_BUDGET = 400;
export const DIGEST_TURNS = 6;
const DIGEST_QUESTION = 200;
const DIGEST_SUMMARY = 160;
const DIGEST_NODES = 8;
/** Node ids listed as "in play" (most recent turn first). */
const IN_PLAY = 12;
const CHARS_PER_TOKEN = 4;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A conversation id: a slug of at most CHAT_ID_MAX characters (never a path). */
export function isChatId(id: unknown): id is string {
  return typeof id === "string" && id.length <= CHAT_ID_MAX && SLUG_RE.test(id);
}

export const conversationFile = (id: string) => `${CONVERSATIONS_DIR}/${id}.json`;
/** Where the agent writes the next turn of a thread in the terminal (gitignored; `lens save --thread` reads it). */
export const draftFile = (id: string) => `${CONVERSATIONS_DIR}/${id}.draft.json`;

function assertId(id: string): void {
  if (!isChatId(id)) throw new Error(`not a conversation id (lowercase letters, digits and dashes, at most ${CHAT_ID_MAX}): ${id}`);
}

/** A conversation by id: the parsed file, or the problems that keep it out; undefined when there is no such file. */
export function readConversation(repoArg: string, id: string): { conversation?: Conversation; problems: Problem[] } | undefined {
  assertId(id);
  const abs = join(resolve(repoArg), conversationFile(id));
  if (!existsSync(abs)) return undefined;
  const { value, problems } = parseJson(readFileSync(abs, "utf8"));
  const found = problems.length ? problems : validateConversation(value);
  if (!found.length && (value as Conversation).id !== id)
    found.push({ path: "id", message: `"${(value as Conversation).id}" must match the file name (${id}.json)` });
  return found.length ? { problems: found } : { conversation: value as Conversation, problems: [] };
}

/** The conversation `id`, or a thrown error naming why it cannot be used. */
export function loadConversation(repo: string, id: string): Conversation {
  const r = readConversation(repo, id);
  if (!r) throw new Error(`unknown conversation: ${id} (\`ultraview chat list\` lists them; \`ultraview chat new\` starts one)`);
  if (!r.conversation) throw new Error(`${conversationFile(id)} is invalid: ${r.problems.map((p) => `${p.path || "(root)"}: ${p.message}`).join("; ")}`);
  return r.conversation;
}

/** Conversation ids on disk, sorted (drafts and other files left out). */
export function conversationIds(repoArg: string): string[] {
  const dir = join(resolve(repoArg), CONVERSATIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json") && isChatId(n.slice(0, -".json".length)))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}

/** Every valid conversation, and the problems of the invalid ones (`check` reports them). */
export function loadConversations(repo: string): { conversations: Conversation[]; problems: FileProblem[] } {
  const conversations: Conversation[] = [];
  const problems: FileProblem[] = [];
  for (const id of conversationIds(repo)) {
    const r = readConversation(repo, id)!;
    if (r.conversation) conversations.push(r.conversation);
    for (const p of r.problems) problems.push({ file: conversationFile(id), ...p });
  }
  return { conversations, problems };
}

/** 0-based indices of the turns whose cited files changed since they were saved. */
export function staleTurns(repoArg: string, c: Conversation): number[] {
  const repo = resolve(repoArg);
  const out: number[] = [];
  c.turns.forEach((t, i) => {
    if (Object.entries(t.sources).some(([rel, sha]) => fileSha256(join(repo, rel)) !== sha)) out.push(i);
  });
  return out;
}

const updatedAt = (c: Conversation) => c.turns.at(-1)?.at ?? c.createdAt;

export interface ChatListEntry {
  id: string;
  title: string;
  turns: number;
  updatedAt: string;
  /** Turns gone stale (a cited file changed). */
  stale: number;
}

/** Every valid conversation, the most recently updated first. */
export function chatList(repoArg: string): { conversations: ChatListEntry[]; invalid: FileProblem[] } {
  const repo = resolve(repoArg);
  const { conversations, problems } = loadConversations(repo);
  const list = conversations
    .map((c) => ({ id: c.id, title: c.title, turns: c.turns.length, updatedAt: updatedAt(c), stale: staleTurns(repo, c).length }))
    .sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
  return { conversations: list, invalid: problems };
}

/** The slug of a title (folded to ASCII, words joined by `-`), de-duplicated against the saved conversations. */
export function proposeChatId(repoArg: string, title: string): string {
  const taken = new Set(conversationIds(repoArg));
  const words = codeindex
    .foldText(title)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let base = "";
  for (const w of words) {
    const next = base ? `${base}-${w}` : w;
    if (next.length > 48) break;
    base = next;
  }
  if (!SLUG_RE.test(base)) base = "conversation";
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const sp = head.lastIndexOf(" ");
  return `${(sp > max / 2 ? head.slice(0, sp) : head).trimEnd()}…`;
}

function checkTitle(title: string | undefined): string | { error: string } {
  const t = oneLine(title ?? "");
  if (!t) return DEFAULT_CHAT_TITLE;
  if (t.length > CHAT_TITLE_MAX) return { error: `the title is longer than ${CHAT_TITLE_MAX} characters` };
  return t;
}

/** `chat new`: an empty conversation, written. */
export function chatNew(repoArg: string, opts: { title?: string; id?: string; now?: Date } = {}): Conversation {
  const repo = resolve(repoArg);
  const title = checkTitle(opts.title);
  if (typeof title !== "string") throw new Error(title.error);
  const id = opts.id ?? proposeChatId(repo, title);
  assertId(id);
  if (existsSync(join(repo, conversationFile(id)))) throw new Error(`${conversationFile(id)} already exists`);
  const c: Conversation = { id, title, createdAt: (opts.now ?? new Date()).toISOString(), turns: [] };
  writeFileAtomic(join(repo, conversationFile(id)), stableJson(c));
  return c;
}

// --- context -----------------------------------------------------------------

/** What a context can be resolved against: the map's nodes, flows and insights. */
export interface ContextView {
  byId: ReadonlyMap<string, ViewNode>;
  flows: readonly Flow[];
  insights: readonly Insight[];
}

/** A context from untrusted input (a request body, `--context`), or why it is refused. */
export function checkContext(v: unknown): ChatContext | { error: string } {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return { error: "`context` must be an object: {node?, edge?, insight?, step?}" };
  const out: ChatContext = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k !== "node" && k !== "edge" && k !== "insight" && k !== "step") return { error: `unknown context key "${k}" (node, edge, insight, step)` };
    if (val === undefined) continue;
    if (typeof val !== "string" || !val.trim()) return { error: `context.${k} must be a non-empty string` };
    if (val.length > CONTEXT_MAX) return { error: `context.${k} is longer than ${CONTEXT_MAX} characters` };
    out[k] = val.trim();
  }
  return out;
}

const hasContext = (c: ChatContext | undefined): c is ChatContext => !!c && Object.keys(c).length > 0;

/**
 * The node ids a context points at, and a line saying what was clicked: a
 * node; an edge's two ends (`"<from> -> <to>"`); an insight's nodes (at most
 * 8); a flow step's node (`"<flow-id>:<n>"`, n from 1). An id the map does not
 * know is an error.
 */
export function resolveContext(view: ContextView, ctx: ChatContext): { nodes: string[]; lines: string[] } | { error: string } {
  const nodes: string[] = [];
  const lines: string[] = [];
  const known = (id: string, what: string): string | undefined => (view.byId.has(id) ? undefined : `unknown ${what}: ${id}`);
  const label = (id: string) => view.byId.get(id)?.label ?? id;
  if (ctx.node !== undefined) {
    const e = known(ctx.node, "node");
    if (e) return { error: `context.node: ${e}` };
    nodes.push(ctx.node);
    lines.push(`node ${ctx.node} (${label(ctx.node)})`);
  }
  if (ctx.edge !== undefined) {
    const m = /^(.+?)\s*->\s*(.+)$/.exec(ctx.edge);
    if (!m) return { error: 'context.edge must be "<from-id> -> <to-id>"' };
    for (const id of [m[1]!, m[2]!]) {
      const e = known(id, "node");
      if (e) return { error: `context.edge: ${e}` };
    }
    nodes.push(m[1]!, m[2]!);
    lines.push(`edge ${m[1]} -> ${m[2]} (${label(m[1]!)} to ${label(m[2]!)})`);
  }
  if (ctx.insight !== undefined) {
    const ins = view.insights.find((i) => i.id === ctx.insight);
    if (!ins) return { error: `context.insight: unknown insight: ${ctx.insight}` };
    nodes.push(...ins.nodes.filter((n) => view.byId.has(n)).slice(0, 8));
    lines.push(`insight ${ins.id}: ${ins.title}`);
  }
  if (ctx.step !== undefined) {
    const m = /^([a-z0-9][a-z0-9-]*):(\d+)$/.exec(ctx.step);
    if (!m) return { error: 'context.step must be "<flow-id>:<n>" (n from 1)' };
    const flow = view.flows.find((f) => f.id === m[1]);
    const step = flow?.steps[Number(m[2]) - 1];
    if (!flow || !step) return { error: `context.step: unknown flow step: ${ctx.step}` };
    if (view.byId.has(step.node)) nodes.push(step.node);
    lines.push(`step ${m[2]} of flow ${flow.id} ("${flow.title}"): ${step.node}`);
  }
  return { nodes: [...new Set(nodes)], lines };
}

// --- the digest ----------------------------------------------------------------

/** The first sentence of an answer, citations and markup stripped, on one line. */
export function answerSummary(answer: string): string {
  const first = splitSentences(answer)[0] ?? answer;
  return cut(oneLine(first.replace(/\[[^\]\n]*\]/g, " ").replace(/[*_`#>]/g, "")), DIGEST_SUMMARY);
}

/** The node ids of each previous turn, most recent first: its answer's nodes, then what it was asked about. */
export function turnNodes(t: ChatTurn): string[] {
  const out = [...t.answer.nodes];
  if (t.answer.focus && !out.includes(t.answer.focus)) out.unshift(t.answer.focus);
  for (const v of [t.context?.node, ...(t.context?.edge ? t.context.edge.split(/\s*->\s*/) : [])]) if (v && kindOf(v) && !out.includes(v)) out.push(v);
  return out;
}

/** Node ids in play: the most recent turn's first, then earlier ones', each once. */
export function inPlay(c: Conversation, max = IN_PLAY): string[] {
  const out: string[] = [];
  for (const t of [...c.turns].reverse().slice(0, DIGEST_TURNS)) for (const n of turnNodes(t)) if (!out.includes(n)) out.push(n);
  return out.slice(0, max);
}

function digestTurn(t: ChatTurn, n: number): string {
  const nodes = turnNodes(t);
  const lines = [
    `${n}. [${t.lang}, ${t.mode}] ${JSON.stringify(cut(oneLine(t.question), DIGEST_QUESTION))}`,
    `   answer: ${answerSummary(t.answer.answer)}`,
    `   nodes: ${nodes.slice(0, DIGEST_NODES).join(", ") || "(none)"}${nodes.length > DIGEST_NODES ? ` (+${nodes.length - DIGEST_NODES})` : ""}`,
  ];
  const about = [
    t.context?.node && `node ${t.context.node}`,
    t.context?.edge && `edge ${t.context.edge}`,
    t.context?.insight && `insight ${t.context.insight}`,
    t.context?.step && `step ${t.context.step}`,
  ].filter(Boolean);
  if (about.length) lines.push(`   asked about: ${about.join("; ")}`);
  return lines.join("\n");
}

/**
 * The compact memory of a thread, for its next question: the most recent
 * DIGEST_TURNS turns (question, a one-line answer summary, node ids, what
 * was clicked), oldest first, then the node ids in play. The oldest turns are
 * left out first to stay within `budget` tokens (DIGEST_BUDGET); "" for an
 * empty thread. Deterministic.
 */
export function chatDigest(c: Conversation, budget = DIGEST_BUDGET): string {
  if (!c.turns.length) return "";
  const max = budget * CHARS_PER_TOKEN;
  const from = Math.max(0, c.turns.length - DIGEST_TURNS);
  const blocks = c.turns.slice(from).map((t, i) => digestTurn(t, from + i + 1));
  const play = inPlay(c);
  const tail = play.length ? [`In play (most recent first): ${play.join(", ")}`] : [];
  const render = (bs: string[]) => {
    const left = c.turns.length - bs.length;
    const head = `## Conversation so far (thread ${c.id}: ${c.turns.length} turn(s)${left ? `, the ${left} oldest left out` : ""}; most recent last)`;
    return [head, ...bs, ...tail].join("\n");
  };
  let kept = blocks;
  let text = render(kept);
  while (text.length > max && kept.length > 1) {
    kept = kept.slice(1);
    text = render(kept);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// --- saving a turn ---------------------------------------------------------------

/** The keys a turn file may hold besides the lens fields. */
const TURN_KEYS = new Set(["lang", "mode", "followUps", "context"]);
const LENS_KEYS = new Set(["schema", "id", "question", "answer", "nodes", "edges", "focus"]);

export interface SaveTurnOptions {
  /** Append to this conversation; absent: a new one is created (`create`). */
  thread?: string;
  /** For a new conversation: its id and title (default: from the question). */
  create?: { id?: string; title?: string };
  /** The question asked, forced over the input's (the Ask bridge). */
  question?: string;
  /** Forced over the input's; default: the input's, else the thread's last, else business. */
  mode?: ChatMode;
  context?: ChatContext;
  source?: TurnSource;
  ms?: number;
  now?: Date;
  /** The map the node ids and the context resolve against (default: `contextView(repo)`). */
  view?: ContextView;
}

export interface TurnResult {
  ok: boolean;
  /** The conversation id (proposed, for a refused first turn). */
  thread: string;
  /** Repo-relative conversation file. */
  file: string;
  /** 0-based position of the turn in `turns`. */
  index: number;
  /** The conversation was created by this turn. */
  created: boolean;
  turn?: ChatTurn;
  errors: Problem[];
}

/**
 * Validate one turn (a lens answer plus `lang`, `mode`, `followUps`,
 * `context`) and append it to its conversation. The gates are `lens save`'s
 * (schema, citations: `prepareLens`) and `check`'s (node ids, every sentence
 * cited: `answerProblems`); then the follow-ups (exactly 3 from an agent, at
 * most 3 from the facts, each one line), the language tag, the mode, the
 * context, the thread's length. Nothing is written when any fails.
 */
export function saveTurn(repoArg: string, input: unknown, opts: SaveTurnOptions = {}): TurnResult {
  const repo = resolve(repoArg);
  const source = opts.source ?? "agent";
  let value = input;
  if (typeof input === "string") {
    const parsed = parseJson(input);
    value = parsed.value;
    if (parsed.problems.length) value = undefined;
  }
  const rec = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

  // The thread: an existing one, or the one this first turn creates.
  let conv: Conversation | undefined;
  let thread: string;
  const errors: Problem[] = [];
  if (opts.thread !== undefined) {
    thread = opts.thread;
    conv = loadConversation(repo, thread);
    if (conv.turns.length >= CHAT_TURNS_MAX)
      errors.push({ path: "turns", message: `the conversation already holds ${CHAT_TURNS_MAX} turns: start a new one (\`ultraview chat new\`)` });
  } else {
    const question = typeof (opts.question ?? rec?.question) === "string" ? String(opts.question ?? rec?.question) : "";
    const title = checkTitle(opts.create?.title ?? cut(oneLine(question), CHAT_TITLE_MAX));
    thread = opts.create?.id ?? proposeChatId(repo, typeof title === "string" ? title : DEFAULT_CHAT_TITLE);
    assertId(thread);
    if (typeof title !== "string") errors.push({ path: "title", message: title.error });
  }
  const file = conversationFile(thread);
  const index = conv?.turns.length ?? 0;
  const fail = (more: Problem[] = []): TurnResult => ({ ok: false, thread, file, index, created: false, errors: [...errors, ...more] });
  if (!rec)
    return fail([{ path: "", message: typeof input === "string" ? (parseJson(input).problems[0]?.message ?? "not a JSON object") : "must be an object" }]);

  // The lens fields go through lens save's own gates; the turn's own keys are checked here.
  const lensPart: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (LENS_KEYS.has(k)) lensPart[k] = v;
    else if (!TURN_KEYS.has(k)) errors.push({ path: k, message: `unknown key "${k}" (allowed: ${[...LENS_KEYS, ...TURN_KEYS].join(", ")})` });
  }
  const question = opts.question ?? lensPart.question;
  if (typeof question === "string" && question.length > CHAT_QUESTION_MAX)
    errors.push({ path: "question", message: `longer than ${CHAT_QUESTION_MAX} characters` });
  const prepared = prepareLens(repo, { ...lensPart, schema: 1, id: thread, question });
  errors.push(...prepared.errors);
  const lens = prepared.item as Lens | undefined;
  let view = opts.view;
  const mapView = () => (view ??= contextView(repo));
  if (lens && !prepared.errors.length) errors.push(...answerProblems(lens, new Set(mapView().byId.keys())));

  const followUps = rec.followUps ?? [];
  if (!Array.isArray(followUps) || followUps.some((f) => typeof f !== "string" || !oneLine(f)))
    errors.push({ path: "followUps", message: "must be an array of non-empty strings" });
  const ups = Array.isArray(followUps) ? followUps.filter((f): f is string => typeof f === "string").map(oneLine) : [];
  if (source === "agent" && Array.isArray(followUps) && followUps.length !== FOLLOW_UPS)
    errors.push({ path: "followUps", message: `exactly ${FOLLOW_UPS} follow-up questions, in the question's language (got ${followUps.length})` });
  if (source === "facts" && ups.length > FOLLOW_UPS) errors.push({ path: "followUps", message: `at most ${FOLLOW_UPS} follow-ups (got ${ups.length})` });
  ups.forEach((f, i) => {
    if (f.length > FOLLOW_UP_MAX) errors.push({ path: `followUps[${i}]`, message: `longer than ${FOLLOW_UP_MAX} characters` });
  });

  let lang = typeof question === "string" ? guessLang(question) : "und";
  if (rec.lang !== undefined) {
    if (typeof rec.lang !== "string" || !LANG_RE.test(rec.lang))
      errors.push({ path: "lang", message: `"${String(rec.lang)}" is not a language tag (en, fr, pt-BR…)` });
    else lang = rec.lang;
  }

  let mode: ChatMode = opts.mode ?? conv?.turns.at(-1)?.mode ?? "business";
  if (opts.mode === undefined && rec.mode !== undefined) {
    if (!(CHAT_MODES as readonly unknown[]).includes(rec.mode)) errors.push({ path: "mode", message: `must be one of ${CHAT_MODES.join(", ")}` });
    else mode = rec.mode as ChatMode;
  }

  let context: ChatContext | undefined = opts.context;
  if (context === undefined && rec.context !== undefined) {
    const c = checkContext(rec.context);
    if ("error" in c) errors.push({ path: "context", message: c.error as string });
    else context = c;
  }
  if (hasContext(context)) {
    const r = resolveContext(mapView(), context);
    if ("error" in r) errors.push({ path: "context", message: r.error });
  }

  if (errors.length || !lens) return fail();
  const turn: ChatTurn = {
    question: lens.question,
    lang,
    mode,
    ...(hasContext(context) ? { context } : {}),
    source,
    answer: { answer: lens.answer, nodes: lens.nodes, ...(lens.edges ? { edges: lens.edges } : {}), ...(lens.focus ? { focus: lens.focus } : {}) },
    followUps: ups,
    sources: prepared.sources,
    at: (opts.now ?? new Date()).toISOString(),
    ...(opts.ms !== undefined ? { ms: Math.max(0, Math.round(opts.ms)) } : {}),
  };
  const created = !conv;
  const title = checkTitle(opts.create?.title ?? cut(oneLine(lens.question), CHAT_TITLE_MAX));
  const next: Conversation = conv
    ? {
        ...conv,
        ...(conv.turns.length === 0 && conv.title === DEFAULT_CHAT_TITLE ? { title: cut(oneLine(lens.question), CHAT_TITLE_MAX) } : {}),
        turns: [...conv.turns, turn],
      }
    : { id: thread, title: typeof title === "string" ? title : DEFAULT_CHAT_TITLE, createdAt: turn.at, turns: [turn] };
  if (created && existsSync(join(repo, file))) return fail([{ path: "id", message: `${file} already exists` }]);
  writeFileAtomic(join(repo, file), stableJson(next));
  return { ok: true, thread, file, index, created, turn, errors: [] };
}

/** The map as its files stand, for resolving node ids and a context (insights: those the last `build` found). */
export function contextView(repoArg: string): ContextView {
  const repo = resolve(repoArg);
  const live = liveView(repo);
  let viewText: string | undefined;
  try {
    viewText = readFileSync(viewPaths(repo).view, "utf8");
  } catch {
    viewText = undefined;
  }
  return { byId: live.byId, flows: live.view.flows, insights: carriedOver(viewText).insights ?? [] };
}

// --- promote -------------------------------------------------------------------------

/** `chat promote <id> <turn>`: turn `n` (from 1) saved as a lens, through `lens save` (sources re-stamped). */
export function promoteTurn(
  repoArg: string,
  id: string,
  n: number,
  opts: { lensId?: string; force?: boolean; proposeId: (question: string) => string },
): SaveResult {
  const repo = resolve(repoArg);
  const c = loadConversation(repo, id);
  const t = c.turns[n - 1];
  if (!Number.isInteger(n) || !t) throw new Error(`${id} has no turn ${n} (it holds ${c.turns.length}; turns count from 1)`);
  const lensId = opts.lensId ?? opts.proposeId(t.question);
  return saveLens(repo, { schema: 1, id: lensId, question: t.question, ...t.answer }, { force: opts.force });
}

// --- text ------------------------------------------------------------------------------

export function formatChatList(r: ReturnType<typeof chatList>): string {
  if (!r.conversations.length && !r.invalid.length) return "conversations none yet: `ultraview chat new` starts one\n";
  const lines = [`conversations ${r.conversations.length}`];
  for (const c of r.conversations)
    lines.push(`  ${c.id}  ${c.turns} turn(s)  updated ${c.updatedAt.slice(0, 10)}${c.stale ? `  [${c.stale} stale]` : ""}`, `    ${c.title}`);
  if (r.invalid.length) {
    lines.push("invalid (run `ultraview check`)");
    for (const p of r.invalid) lines.push(`  ${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatConversation(c: Conversation, stale: readonly number[] = []): string {
  const lines = [`conversation ${c.id}  "${c.title}"  created ${c.createdAt}  ${c.turns.length} turn(s)`];
  c.turns.forEach((t, i) => {
    lines.push(
      "",
      `## Turn ${i + 1}  [${t.lang}, ${t.mode}, ${t.source}]  ${t.at}${stale.includes(i) ? "  STALE" : ""}`,
      `Q: ${t.question}`,
      ...(hasContext(t.context)
        ? [
            `about: ${Object.entries(t.context)
              .map(([k, v]) => `${k} ${v}`)
              .join("; ")}`,
          ]
        : []),
      "",
      t.answer.answer,
      "",
      `nodes: ${t.answer.nodes.join(", ") || "(none)"}${t.answer.focus ? `  focus: ${t.answer.focus}` : ""}`,
      ...(t.followUps.length ? ["follow-ups:", ...t.followUps.map((f) => `  - ${f}`)] : []),
    );
  });
  lines.push("", `open it: #chat=${c.id} (live when \`ultraview serve\` runs); promote a turn to a lens: \`ultraview chat promote ${c.id} <turn>\``);
  return `${lines.join("\n")}\n`;
}
