// The chat panel's controller: the thread state (lib/chat.ts), kept in step
// with `#chat=` and the live `chat` event, fed by `/api/chat`, `/api/chats`
// and `/api/explain` when served, by the conversations `render` embedded when
// not. Returns the panel's API (context.ts `ChatApi`) and the live `chat`
// handler.

import { useCallback, useEffect, useMemo, useReducer, useRef } from "preact/hooks";
import type { Insight } from "../lib/changes.js";
import {
  answerIds,
  type ChatContext,
  chatEntries,
  chatMode,
  chatReducer,
  chatRunning,
  initialChat,
  listOf,
  nodeContext,
  type TurnAnswer,
  type ViewConversation,
} from "../lib/chat.js";
import type { Index } from "../lib/data.js";
import { t } from "../lib/i18n.js";
import { type LiveState, questionOk } from "../lib/live.js";
import { fetchChatList, fetchConversation, postExplain, streamChat } from "./chatApi.js";
import type { AppApi, ChatApi, ChatCan, UiState } from "./context.js";
import { canBeLive } from "./live.js";

/** How long a served page waits for the event stream before calling a linked conversation missing. */
const CONNECT_WAIT_MS = 2500;

interface Deps {
  ix: Index;
  insights: readonly Insight[];
  state: UiState;
  stateRef: { current: UiState };
  update: AppApi["update"];
  reveal: AppApi["reveal"];
  live: LiveState;
  lang: string;
  narrow: boolean;
  embedded: readonly ViewConversation[];
}

/** A refused `/api/chat` (JSON before any stream), in words. */
function refusal(status: number, error: string | undefined, thread: string | undefined): string {
  if (status === 0) return t("ask.network");
  if (status === 409 && /already running/.test(error ?? "")) return t("ask.busy");
  if (status === 404 && !thread) return t("ask.offError");
  return error || t("chat.failedNoDetail");
}

export function useChat(d: Deps): { api: ChatApi; onChat: (id: string) => void } {
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const ref = useRef(chat);
  ref.current = chat;
  const deps = useRef(d);
  deps.current = d;
  const seq = useRef(0);
  const nextKey = () => `c${++seq.current}`;
  const connected = d.live.connected;

  const can: ChatCan = !connected ? "static" : !d.live.ask ? "noagent" : d.live.run || chatRunning(chat) ? "busy" : "ready";
  const canRef = useRef(can);
  canRef.current = can;

  // The conversation follows `#chat=` (a link, back / forward, the list)…
  useEffect(() => {
    const want = d.state.chat;
    if (want === ref.current.thread) return;
    if (want !== undefined || ref.current.thread !== undefined) dispatch({ type: "open", ...(want !== undefined ? { thread: want } : {}) });
  }, [d.state.chat]);
  // …and a new conversation's first turn names it.
  useEffect(() => {
    const s = deps.current.stateRef.current;
    if (chat.thread && s.chat === undefined) deps.current.update({ chat: chat.thread }, "replace");
  }, [chat.thread]);

  // Read the open conversation: from serve when live, else from what the page embedded.
  useEffect(() => {
    const id = chat.thread;
    if (!id || !(chat.loading || chat.behind)) return;
    if (connected) {
      let current = true;
      void fetchConversation(id).then((r) => {
        if (!current) return;
        if (r.conversation) dispatch({ type: "loaded", conversation: r.conversation });
        else dispatch({ type: "load-failed", thread: id, error: r.status === 404 ? t("chat.notFound", { id }) : (r.error ?? t("ask.network")) });
      });
      return () => {
        current = false;
      };
    }
    const found = deps.current.embedded.find((c) => c.id === id);
    if (found) {
      dispatch({ type: "loaded", conversation: found });
      return;
    }
    const missing = () => dispatch({ type: "load-failed", thread: id, error: t("chat.notEmbedded", { id }) });
    if (!canBeLive()) {
      missing();
      return;
    }
    const timer = setTimeout(missing, CONNECT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [chat.thread, chat.loading, chat.behind, connected]);

  const refreshList = useCallback(() => {
    if (!deps.current.live.connected) {
      dispatch({ type: "list", items: listOf(deps.current.embedded) });
      return;
    }
    void fetchChatList().then((items) => {
      if (items) dispatch({ type: "list", items });
    });
  }, []);

  // A conversation file changed (a turn saved from the terminal, or by any page).
  const onChat = useCallback(
    (id: string) => {
      if (id === ref.current.thread)
        void fetchConversation(id).then((r) => {
          if (r.conversation) dispatch({ type: "loaded", conversation: r.conversation });
        });
      if (ref.current.list) refreshList();
    },
    [refreshList],
  );

  const show = useCallback((answer: TurnAnswer, label: string, go = false) => {
    const { ix, stateRef, update, reveal, narrow } = deps.current;
    const ids = answerIds(answer, (id) => ix.byId.has(id));
    if (!ids.length) return;
    const spotlight = { ids, label: t("spot.chat", { q: label }) };
    const focus = answer.focus && ix.byId.has(answer.focus) ? answer.focus : ids[0]!;
    if (go) {
      if (narrow) update({ chatOpen: false });
      reveal(focus, spotlight);
    } else if (stateRef.current.view === "map") update({ spotlight, center: { id: focus, nonce: Date.now() } });
  }, []);

  const send = useCallback(
    (question: string, opts: { context?: ChatContext; from?: string } = {}) => {
      const q = question.trim();
      if (!questionOk(q) || canRef.current !== "ready") return;
      const key = nextKey();
      const thread = ref.current.thread;
      const mode = chatMode(deps.current.stateRef.current.audience);
      const context = opts.context && Object.keys(opts.context).length ? opts.context : undefined;
      dispatch({ type: "send", key, question: q, mode, ...(context ? { context } : {}), ...(opts.from ? { from: opts.from } : {}) });
      void streamChat({ ...(thread ? { thread } : {}), question: q, mode, ...(context ? { context } : {}) }, (e) => {
        if (e.type === "progress") dispatch({ type: "progress", key, text: e.text });
        else if (e.type === "turn") {
          dispatch({ type: "turn", key, thread: e.thread, index: e.index, turn: e.turn });
          show(e.turn.answer, q);
          if (ref.current.list) refreshList();
        } else dispatch({ type: "failed", key, error: e.message || t("chat.failedNoDetail") });
      }).then((r) => {
        if (r.status !== 200) dispatch({ type: "failed", key, error: refusal(r.status, r.error, thread) });
      });
    },
    [show, refreshList],
  );

  const explain = useCallback(
    (node: string) => {
      const { ix, stateRef, lang } = deps.current;
      // Asked again about the same node: the instant answer is already the last thing shown.
      const last = chatEntries(ref.current).at(-1);
      if (last?.type === "local" && last.entry.context?.node === node && (last.entry.status === "explaining" || last.entry.status === "facts")) return;
      const key = nextKey();
      const mode = chatMode(stateRef.current.audience);
      const question = t("chat.explainQuestion", { label: ix.byId.get(node)?.label ?? node });
      dispatch({ type: "explain", key, question, context: nodeContext(node), mode });
      void postExplain(node, mode, lang).then((r) => {
        if (r.facts) {
          dispatch({ type: "explained", key, facts: r.facts });
          show(r.facts.answer, question);
        } else dispatch({ type: "failed", key, error: r.status === 0 ? t("ask.network") : (r.error ?? t("chat.failedNoDetail")) });
      });
    },
    [show],
  );

  const open = useCallback<ChatApi["open"]>(
    (opts = {}) => {
      const { update } = deps.current;
      if (opts.thread === null) {
        dispatch({ type: "open" });
        update({ chatOpen: true, chat: undefined, chatFocus: Date.now() }, "replace");
      } else if (opts.thread) update({ chatOpen: true, chat: opts.thread, chatFocus: Date.now() }, "push");
      else update({ chatOpen: true, chatFocus: Date.now() }, "replace");
      if (opts.context) {
        dispatch({ type: "draft", context: opts.context });
        if (opts.context.node && deps.current.live.connected) explain(opts.context.node);
      }
    },
    [explain],
  );

  const close = useCallback(() => deps.current.update({ chatOpen: false }), []);
  const setDraft = useCallback((context?: ChatContext) => dispatch({ type: "draft", ...(context ? { context } : {}) }), []);
  const dismiss = useCallback((key: string) => dispatch({ type: "dismiss", key }), []);
  const openNode = useCallback((id: string) => {
    const { stateRef, update, narrow, ix } = deps.current;
    if (!ix.byId.has(id)) return;
    update({
      selected: id,
      panelOpen: true,
      ...(stateRef.current.view === "map" ? { center: { id, nonce: Date.now() } } : {}),
      ...(narrow ? { chatOpen: false } : {}),
    });
  }, []);

  const api = useMemo<ChatApi>(
    () => ({ state: chat, can, embedded: d.embedded, open, close, send, setDraft, dismiss, refreshList, show, openNode }),
    [chat, can, d.embedded, open, close, send, setDraft, dismiss, refreshList, show, openNode],
  );
  return { api, onChat };
}
