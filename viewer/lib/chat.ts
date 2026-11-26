// The chat panel's pure logic (docs/design.md §8): conversations
// (`.ultraview/conversations/<id>.json`, read from `ultraview serve` or
// embedded by `render`), the thread a page shows — saved turns, plus this
// page's instant answers (`POST /api/explain`), runs in flight and failures —
// the event stream `POST /api/chat` answers with, what "Ask about this"
// sends as `context`, and which node a citation points at. No DOM here.

import type { ChatContext, ChatMode, ChatTurn, LensEdge, TurnAnswer } from "../../src/model/types.js";
import type { Insight } from "./changes.js";
import { type Index, pathOf, type XNode } from "./data.js";
import { t } from "./i18n.js";
import { nodeLabels } from "./labels.js";
import type { ViewerAudience } from "./levels.js";
import type { CiteRef } from "./markdown.js";

export type { ChatContext, ChatMode, TurnAnswer };

/** A turn as the viewer reads it: `sources` is left out of embedded pages. */
export type ViewTurn = Omit<ChatTurn, "sources">;

export interface ViewConversation {
  id: string;
  title: string;
  createdAt: string;
  turns: ViewTurn[];
}

export interface ChatListItem {
  id: string;
  title: string;
  turns: number;
  updatedAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The business / developer toggle, as the `mode` a turn is asked in. */
export function chatMode(audience: ViewerAudience): ChatMode {
  return audience === "developer" ? "dev" : "business";
}

// --- reading untrusted JSON (the server's, or what render embedded) -------------------

function readContext(v: unknown): ChatContext | undefined {
  if (!isObj(v)) return undefined;
  const out: ChatContext = {};
  for (const k of ["node", "edge", "insight", "step"] as const) {
    const s = str(v[k]);
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

function readEdges(v: unknown): LensEdge[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => isObj(e) && typeof e.from === "string" && typeof e.to === "string")
    .map((e) => ({ from: e.from as string, to: e.to as string, ...(typeof e.kind === "string" ? { kind: e.kind as LensEdge["kind"] } : {}) }));
}

/** A lens-shaped answer (`{answer, nodes, edges?, focus?}`), or undefined. */
export function readAnswer(v: unknown): TurnAnswer | undefined {
  if (!isObj(v) || typeof v.answer !== "string") return undefined;
  const edges = readEdges(v.edges);
  const focus = str(v.focus);
  return { answer: v.answer, nodes: strs(v.nodes), ...(edges.length ? { edges } : {}), ...(focus ? { focus } : {}) };
}

/** One turn, or undefined when it is not one. */
export function readTurn(v: unknown): ViewTurn | undefined {
  if (!isObj(v) || typeof v.question !== "string") return undefined;
  const answer = readAnswer(v.answer);
  if (!answer) return undefined;
  const context = readContext(v.context);
  return {
    question: v.question,
    lang: str(v.lang) ?? "und",
    mode: v.mode === "dev" ? "dev" : "business",
    ...(context ? { context } : {}),
    source: v.source === "facts" ? "facts" : "agent",
    answer,
    followUps: strs(v.followUps).slice(0, 3),
    at: str(v.at) ?? "",
    ...(typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? { ms: v.ms } : {}),
  };
}

/** A conversation, or undefined (its unreadable turns left out). */
export function readConversation(v: unknown): ViewConversation | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || !Array.isArray(v.turns)) return undefined;
  return {
    id: v.id,
    title: str(v.title) || v.id,
    createdAt: str(v.createdAt) ?? "",
    turns: v.turns.map(readTurn).filter((x): x is ViewTurn => !!x),
  };
}

/** The conversations `render` embedded (or anything else: junk is dropped). */
export function readConversations(v: unknown): ViewConversation[] {
  return Array.isArray(v) ? v.map(readConversation).filter((x): x is ViewConversation => !!x) : [];
}

/** `GET /api/chats`, read. */
export function readChatList(v: unknown): ChatListItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Record<string, unknown> => isObj(c) && typeof c.id === "string" && !!c.id)
    .map((c) => ({
      id: c.id as string,
      title: str(c.title) || (c.id as string),
      turns: typeof c.turns === "number" ? c.turns : 0,
      updatedAt: str(c.updatedAt) ?? "",
    }));
}

/** The list of embedded conversations, newest first (what `/api/chats` would answer). */
export function listOf(conversations: readonly ViewConversation[]): ChatListItem[] {
  return conversations
    .map((c) => ({ id: c.id, title: c.title, turns: c.turns.length, updatedAt: c.turns.at(-1)?.at || c.createdAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
}

export interface FactsAnswer {
  answer: TurnAnswer;
  escalate: boolean;
  /** The language asked for had no templates: English was used. */
  langFallback?: string;
}

/** `POST /api/explain`'s answer (`{answer, nodes, edges, escalate, …, source: "facts"}`), read. */
export function readExplain(v: unknown, node: string): FactsAnswer | undefined {
  if (!isObj(v) || typeof v.answer !== "string") return undefined;
  const edges = readEdges(v.edges);
  const fallback = str(v.langFallback);
  return {
    answer: { answer: v.answer, nodes: strs(v.nodes), ...(edges.length ? { edges } : {}), focus: str(v.node) ?? node },
    escalate: v.escalate === true,
    ...(fallback ? { langFallback: fallback } : {}),
  };
}

// --- contexts ------------------------------------------------------------------------

export const nodeContext = (id: string): ChatContext => ({ node: id });
/** An edge, as `/api/chat` reads it: `"<from-id> -> <to-id>"`. */
export const edgeContext = (from: string, to: string): ChatContext => ({ edge: `${from} -> ${to}` });
/** A flow step, `"<flow-id>:<n>"`, n from 1 (`step` is the viewer's 0-based index). */
export const stepContext = (flow: string, step: number): ChatContext => ({ step: `${flow}:${step + 1}` });
export const insightContext = (id: string): ChatContext => ({ insight: id });

/** Whether a node can be named in a context (the server knows view nodes; actors are the viewer's own). */
export function contextable(id: string): boolean {
  return !id.startsWith("actor:");
}

export function parseEdge(edge: string): { from: string; to: string } | undefined {
  const m = /^(.+?)\s*->\s*(.+)$/.exec(edge);
  return m ? { from: m[1]!, to: m[2]! } : undefined;
}

export function parseStep(step: string): { flow: string; n: number } | undefined {
  const m = /^(.+):(\d+)$/.exec(step);
  return m ? { flow: m[1]!, n: Number(m[2]) } : undefined;
}

/** What a context points at, in words (labels from the map; ids when the map does not know them). */
export function contextLabel(ix: Index, insights: readonly Insight[], ctx: ChatContext | undefined): string | undefined {
  if (!ctx) return undefined;
  const label = (id: string) => ix.byId.get(id)?.label ?? id;
  const parts: string[] = [];
  if (ctx.node) parts.push(label(ctx.node));
  if (ctx.edge) {
    const e = parseEdge(ctx.edge);
    // Two same-named ends (orders.ts → orders.ts) get the folder that tells them apart.
    const ends = e ? nodeLabels(ix, [e.from, e.to]) : undefined;
    parts.push(e ? t("chat.ctx.edge", { from: ends?.get(e.from) ?? label(e.from), to: ends?.get(e.to) ?? label(e.to) }) : ctx.edge);
  }
  if (ctx.insight) parts.push(insights.find((i) => i.id === ctx.insight)?.title ?? ctx.insight);
  if (ctx.step) {
    const s = parseStep(ctx.step);
    const flow = s ? (ix.view.flows ?? []).find((f) => f.id === s.flow) : undefined;
    parts.push(s ? t("chat.ctx.step", { n: s.n, flow: flow?.title ?? s.flow }) : ctx.step);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

/** The node ids an answer lights on the map: its focus, its nodes and both ends of its edges, each once. */
export function answerIds(a: TurnAnswer, known: (id: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id) && known(id)) out.push(id);
  };
  add(a.focus);
  for (const n of a.nodes) add(n);
  for (const e of a.edges ?? []) {
    add(e.from);
    add(e.to);
  }
  return out;
}

// --- citations -----------------------------------------------------------------------

/** Nodes by the file they live in, for `citeNode`. */
export function nodesByPath(ix: Index): Map<string, XNode[]> {
  const out = new Map<string, XNode[]>();
  for (const n of ix.nodes) {
    if (n.kind === "actor" || n.kind === "cap" || n.kind === "sys" || n.kind === "mod") continue;
    const p = pathOf(n);
    if (!p) continue;
    const list = out.get(p) ?? [];
    list.push(n);
    out.set(p, list);
  }
  return out;
}

/**
 * The node a citation `[path:line]` points at, for the side panel: the
 * narrowest node whose span holds the line, else the nearest node defined at
 * or above it in that file, else the file. Nodes the answer names win a tie.
 * Undefined when the map holds nothing in that file.
 */
export function citeNode(
  ix: Index,
  byPath: ReadonlyMap<string, readonly XNode[]>,
  cite: Pick<CiteRef, "path" | "line">,
  prefer: readonly string[] = [],
): string | undefined {
  const inFile = byPath.get(cite.path) ?? [];
  let best: { id: string; rank: number; named: boolean } | undefined;
  const better = (id: string, rank: number) => {
    const named = prefer.includes(id);
    if (!best || rank < best.rank || (rank === best.rank && ((named && !best.named) || (named === best.named && id < best.id)))) best = { id, rank, named };
  };
  for (const n of inFile) {
    if (n.kind === "file" || !n.at) continue;
    const m = /:(\d+)(?:-(\d+))?$/.exec(n.at);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : undefined;
    if (end !== undefined && start <= cite.line && cite.line <= end) better(n.id, end - start);
    else if (start <= cite.line) better(n.id, 1e6 + (cite.line - start));
  }
  if (best) return best.id;
  const file = `file:${cite.path}`;
  return ix.byId.has(file) ? file : undefined;
}

// --- the event stream of POST /api/chat ------------------------------------------------

export interface SseFrame {
  event: string;
  data: string;
}

/** A Server-Sent Events reader fed text chunks as they arrive (lines may split anywhere). */
export function sseReader(): { push: (chunk: string) => SseFrame[]; end: () => SseFrame[] } {
  let buf = "";
  let event = "";
  let data: string[] = [];
  const line = (l: string, out: SseFrame[]) => {
    if (l === "") {
      if (data.length) out.push({ event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const colon = l.indexOf(":");
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  const drain = (final: boolean) => {
    const out: SseFrame[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(buf);
      // A lone \r at the end may be half of \r\n: wait for the next chunk.
      if (!m || (m[0] === "\r" && m.index === buf.length - 1 && !final)) break;
      line(buf.slice(0, m.index), out);
      buf = buf.slice(m.index + m[0].length);
    }
    if (final) {
      if (buf) line(buf, out);
      buf = "";
      line("", out);
    }
    return out;
  };
  return {
    push: (chunk) => {
      buf += chunk;
      return drain(false);
    },
    end: () => drain(true),
  };
}

/** One frame of the chat stream, read; undefined for anything else. */
export type ChatStreamEvent =
  | { type: "progress"; text: string }
  | { type: "turn"; thread: string; index: number; turn: ViewTurn }
  | { type: "error"; message: string };

export function readChatFrame(f: SseFrame): ChatStreamEvent | undefined {
  let d: unknown;
  try {
    d = JSON.parse(f.data);
  } catch {
    return undefined;
  }
  if (!isObj(d)) return undefined;
  if (f.event === "progress" && typeof d.text === "string") return { type: "progress", text: d.text };
  if (f.event === "error") return { type: "error", message: str(d.message) ?? "" };
  if (f.event === "turn" && typeof d.thread === "string" && typeof d.index === "number" && Number.isInteger(d.index) && d.index >= 0) {
    const turn = readTurn(d.turn);
    return turn ? { type: "turn", thread: d.thread, index: d.index, turn } : undefined;
  }
  return undefined;
}

/** A progress line of the server (English, fixed wording: src/serve.ts) in the interface language; unknown lines pass as they are. */
export function progressLine(text: string): string {
  let m = /^asking (\S+)/.exec(text);
  if (m) return t("chat.progress.asking", { agent: m[1]! });
  m = /^(\S+) started$/.exec(text);
  if (m) return t("chat.progress.started", { agent: m[1]! });
  m = /^(\S+) is reading the code(?: \((\d+) KB of output\))?$/.exec(text);
  if (m) return m[2] ? t("chat.progress.readingKb", { agent: m[1]!, kb: m[2] }) : t("chat.progress.reading", { agent: m[1]! });
  if (/^checking the answer/.test(text)) return t("chat.progress.checking");
  return text;
}

// --- the thread on screen ----------------------------------------------------------------

/** Something of this page's, between the saved turns: an instant answer, a run in flight, a failure. */
export interface LocalEntry {
  key: string;
  /** How many saved turns precede it. */
  after: number;
  question: string;
  context?: ChatContext;
  mode: ChatMode;
  status: "explaining" | "facts" | "pending" | "error";
  /** status facts: the instant answer. */
  facts?: FactsAnswer;
  /** The facts answer was escalated to the agent. */
  escalated?: boolean;
  /** status pending: the latest progress line, as the server wrote it. */
  progress?: string;
  /** status error: what went wrong. */
  error?: string;
  /** The error came from an instant answer (no retry through the agent). */
  explain?: boolean;
  /** A run: the thread it was sent to (undefined: it creates one). */
  thread?: string;
}

export interface ChatState {
  /** The open conversation; undefined for a new one (its first turn names it). */
  thread?: string;
  title?: string;
  saved: ViewTurn[];
  local: LocalEntry[];
  loading: boolean;
  loadError?: string;
  /** A turn arrived past the saved ones (turns saved elsewhere): re-read the thread. */
  behind?: boolean;
  /** What the next question is about ("Ask about this"). */
  draft?: ChatContext;
  /** The conversations, once listed. */
  list?: ChatListItem[];
}

export const initialChat: ChatState = { saved: [], local: [], loading: false };

export type ChatAction =
  | { type: "open"; thread?: string }
  | { type: "loaded"; conversation: ViewConversation }
  | { type: "load-failed"; thread: string; error: string }
  | { type: "draft"; context?: ChatContext }
  | { type: "explain"; key: string; question: string; context: ChatContext; mode: ChatMode }
  | { type: "explained"; key: string; facts: FactsAnswer }
  | { type: "send"; key: string; question: string; context?: ChatContext; mode: ChatMode; from?: string }
  | { type: "progress"; key: string; text: string }
  | { type: "turn"; key?: string; thread: string; index: number; turn: ViewTurn }
  | { type: "failed"; key: string; error: string }
  | { type: "dismiss"; key: string }
  | { type: "list"; items: ChatListItem[] };

const patchLocal = (s: ChatState, key: string, f: (e: LocalEntry) => LocalEntry): ChatState => ({
  ...s,
  local: s.local.map((e) => (e.key === key ? f(e) : e)),
});

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "open": {
      if (a.thread !== undefined && a.thread === s.thread) return s;
      const next: ChatState = { saved: [], local: [], loading: a.thread !== undefined, ...(a.thread !== undefined ? { thread: a.thread } : {}) };
      if (s.list) next.list = s.list;
      // A new conversation keeps what the next question is about.
      if (a.thread === undefined && s.draft) next.draft = s.draft;
      return next;
    }
    case "loaded": {
      if (a.conversation.id !== s.thread) return s;
      const next: ChatState = { ...s, title: a.conversation.title, saved: a.conversation.turns, loading: false };
      delete next.loadError;
      delete next.behind;
      return next;
    }
    case "load-failed":
      return a.thread === s.thread ? { ...s, loading: false, loadError: a.error } : s;
    case "draft": {
      const next = { ...s };
      if (a.context && Object.keys(a.context).length) next.draft = a.context;
      else delete next.draft;
      return next;
    }
    case "explain":
      return {
        ...s,
        local: [...s.local, { key: a.key, after: s.saved.length, question: a.question, context: a.context, mode: a.mode, status: "explaining" }],
      };
    case "explained":
      return patchLocal(s, a.key, (e) => ({ ...e, status: "facts", facts: a.facts }));
    case "send": {
      const base = a.from ? patchLocal(s, a.from, (e) => ({ ...e, escalated: true })) : s;
      const entry: LocalEntry = {
        key: a.key,
        after: s.saved.length,
        question: a.question,
        ...(a.context ? { context: a.context } : {}),
        mode: a.mode,
        status: "pending",
        ...(s.thread !== undefined ? { thread: s.thread } : {}),
      };
      const next: ChatState = { ...base, local: [...base.local, entry] };
      // The question took what the composer was about with it (a follow-up chip leaves it).
      if (a.context && JSON.stringify(a.context) === JSON.stringify(s.draft)) delete next.draft;
      return next;
    }
    case "progress":
      return patchLocal(s, a.key, (e) => (e.status === "pending" ? { ...e, progress: a.text } : e));
    case "turn": {
      const mine = a.key !== undefined && s.local.some((e) => e.key === a.key);
      const local = a.key !== undefined ? s.local.filter((e) => e.key !== a.key) : s.local;
      // Another conversation's turn (the user moved on while it ran): nothing here changes.
      if (a.thread !== s.thread && !(s.thread === undefined && mine)) return { ...s, local };
      const saved = [...s.saved];
      const next: ChatState = { ...s, thread: a.thread, local, saved };
      if (a.index <= saved.length) saved[a.index] = a.turn;
      else next.behind = true;
      if (next.title === undefined && a.index === 0) next.title = a.turn.question;
      return next;
    }
    case "failed":
      return patchLocal(s, a.key, (e) => ({ ...e, status: "error", error: a.error, ...(e.status === "explaining" ? { explain: true } : {}) }));
    case "dismiss":
      return { ...s, local: s.local.filter((e) => e.key !== a.key) };
    case "list":
      return { ...s, list: a.items };
    default:
      return s;
  }
}

export type ChatEntry = { type: "saved"; index: number; turn: ViewTurn } | { type: "local"; entry: LocalEntry };

/** The thread in order: each local entry before the saved turn that came after it. */
export function chatEntries(s: ChatState): ChatEntry[] {
  const out: ChatEntry[] = [];
  const n = s.saved.length;
  const at = (i: number) => s.local.filter((e) => Math.min(e.after, n) === i);
  for (let i = 0; i <= n; i++) {
    for (const entry of at(i)) out.push({ type: "local", entry });
    const turn = s.saved[i];
    if (turn) out.push({ type: "saved", index: i, turn });
  }
  return out;
}

/** A run of this page is in flight. */
export function chatRunning(s: ChatState): boolean {
  return s.local.some((e) => e.status === "pending");
}

// --- the deep link ---------------------------------------------------------------------

export interface ChatRouteState {
  chat?: string;
  chatOpen: boolean;
}

/** The `#chat=` the hash carries: the open panel's conversation, once it has an id. */
export function routeChat(s: ChatRouteState): string | undefined {
  return s.chatOpen && s.chat ? s.chat : undefined;
}

/**
 * The panel after following a link (or going back): `#chat=<id>` opens that
 * conversation; a link without one closes a named conversation, and leaves a
 * new, unnamed one as it was (its hash never named it).
 */
export function chatFromRoute(chat: string | undefined, prev: ChatRouteState): ChatRouteState {
  if (chat) return { chat, chatOpen: true };
  return { chatOpen: prev.chatOpen && !prev.chat };
}
