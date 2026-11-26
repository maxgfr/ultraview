// The chat panel (docs/design.md §8): a conversation about the app beside any
// view. Each answer lights its nodes on the map and its citations open the
// cited node's card; an agent answer offers its three follow-ups, an instant
// answer (proven facts, `POST /api/explain`) offers the agent. "Ask about
// this" on a node, an edge, an insight or a flow step opens it with that
// context. On a static page (or a server without an agent) it is read-only:
// the conversations `render` embedded, and a prompt to copy.

import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type ChatContext,
  type ChatEntry,
  chatEntries,
  citeNode,
  contextLabel,
  type FactsAnswer,
  type LocalEntry,
  nodesByPath,
  parseEdge,
  parseStep,
  progressLine,
  type TurnAnswer,
} from "../lib/chat.js";
import type { Index } from "../lib/data.js";
import { num, t } from "../lib/i18n.js";
import { QUESTION_MAX, questionOk } from "../lib/live.js";
import { type CiteRef, citeLabel } from "../lib/markdown.js";
import { askAboutEdge, askAboutInsight, askAboutNode, askAboutStep } from "../lib/prompts.js";
import type { Insight } from "../lib/changes.js";
import { useApp } from "./context.js";
import { Icon } from "./icons.js";
import { CiteChip, CopyButton, Markdown } from "./Prose.js";

/** The prompt to copy for the user's own agent when this page cannot ask. */
function promptFor(ix: Index, insights: readonly Insight[], ctx: ChatContext | undefined): string | undefined {
  if (!ctx) return undefined;
  const label = (id: string) => ix.byId.get(id)?.label ?? id;
  if (ctx.node) return askAboutNode(ctx.node, label(ctx.node));
  if (ctx.edge) {
    const e = parseEdge(ctx.edge);
    return e ? askAboutEdge(e.from, e.to) : undefined;
  }
  if (ctx.insight) {
    const i = insights.find((x) => x.id === ctx.insight);
    return i ? (i.prompt ?? askAboutInsight(i.title, i.nodes)) : undefined;
  }
  if (ctx.step) {
    const s = parseStep(ctx.step);
    const flow = s ? (ix.view.flows ?? []).find((f) => f.id === s.flow) : undefined;
    const step = s && flow ? flow.steps[s.n - 1] : undefined;
    return s && flow && step ? askAboutStep(flow.id, flow.title, s.n, step.node) : undefined;
  }
  return undefined;
}

export function ChatPanel(): JSX.Element | null {
  const { state } = useApp();
  return state.chatOpen ? <ChatBody /> : null;
}

function ChatBody(): JSX.Element {
  const { chat, state } = useApp();
  const s = chat.state;
  const [listOpen, setListOpen] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const entries = chatEntries(s);
  const last = entries.at(-1);

  // Focus: into the composer when asked to (else the title); back where it came from on close.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (state.chatFocus === undefined) return;
    (input.current ?? head.current)?.focus({ preventScroll: true });
  }, [state.chatFocus]);
  // The newest entry in view.
  const tail = last ? (last.type === "saved" ? `s${last.index}` : `${last.entry.key}:${last.entry.status}:${last.entry.progress ?? ""}`) : "";
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail, s.loading]);
  useEffect(() => {
    if (!listOpen) return;
    chat.refreshList();
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>("button")?.focus());
  }, [listOpen]);

  const title = s.title ?? (s.thread ? s.thread : t("chat.newTitle"));
  const announce = s.loading
    ? t("chat.loading")
    : !last
      ? ""
      : last.type === "saved"
        ? t("chat.answered")
        : last.entry.status === "pending"
          ? last.entry.progress
            ? progressLine(last.entry.progress)
            : t("chat.progress.sending")
          : last.entry.status === "explaining"
            ? t("chat.explaining")
            : last.entry.status === "facts"
              ? t("chat.instantReady")
              : t("chat.failed");

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const el = e.target as HTMLElement;
    if (listOpen) setListOpen(false);
    else if (el.tagName === "TEXTAREA" && (el as HTMLTextAreaElement).value) return;
    else chat.close();
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <aside class="chat" aria-labelledby="chat-title" onKeyDown={onKey}>
      <header class="chat-head">
        <div class="panel-kind">
          <Icon name="ask" size={14} />
          {t("chat.kicker")}
        </div>
        <h2 id="chat-title" tabIndex={-1} ref={head}>
          {title}
        </h2>
        <div class="chat-tools">
          <button
            type="button"
            class={`btn btn-quiet${listOpen ? " on" : ""}`}
            aria-expanded={listOpen}
            aria-controls="chat-list"
            onClick={() => setListOpen((o) => !o)}
          >
            <Icon name="list" size={14} />
            {t("chat.conversations")}
          </button>
          {chat.can !== "static" ? (
            <button
              type="button"
              class="btn btn-quiet"
              onClick={() => {
                setListOpen(false);
                chat.open({ thread: null });
              }}
            >
              <Icon name="plus" size={14} />
              {t("chat.new")}
            </button>
          ) : null}
        </div>
        <button type="button" class="icon-btn panel-close" aria-label={t("chat.close")} title={t("chat.close")} onClick={() => chat.close()}>
          <Icon name="close" />
        </button>
      </header>
      {listOpen ? (
        <div class="chat-list" id="chat-list" ref={listRef}>
          <ChatList
            onPick={(id) => {
              setListOpen(false);
              chat.open({ thread: id });
            }}
          />
        </div>
      ) : (
        <>
          <div class="chat-thread" ref={scroller}>
            {s.loading ? (
              <p class="chat-note">
                <span class="spinner" aria-hidden="true" />
                {t("chat.loading")}
              </p>
            ) : s.loadError ? (
              <p class="chat-note chat-note-error" role="alert">
                <Icon name="warning" size={14} />
                {s.loadError}
              </p>
            ) : null}
            {!entries.length && !s.loading && !s.loadError ? <ChatEmpty /> : null}
            {entries.length ? (
              <ol class="chat-turns" aria-label={t("chat.thread")}>
                {entries.map((e) => (
                  <EntryView key={e.type === "saved" ? `s${e.index}` : e.entry.key} e={e} />
                ))}
              </ol>
            ) : null}
          </div>
          <Composer inputRef={input} />
        </>
      )}
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </p>
    </aside>
  );
}

function ChatEmpty(): JSX.Element {
  const { chat } = useApp();
  return (
    <div class="chat-empty">
      <Icon name="ask" size={22} />
      <p class="chat-empty-title">{t("chat.emptyTitle")}</p>
      <p class="muted small">{t(chat.can === "static" ? "chat.emptyStatic" : chat.can === "noagent" ? "chat.emptyNoAgent" : "chat.emptyBody")}</p>
    </div>
  );
}

function ChatList({ onPick }: { onPick: (id: string) => void }): JSX.Element {
  const { chat } = useApp();
  const items = chat.state.list;
  if (!items) return <p class="chat-note muted small">{t("chat.loadingList")}</p>;
  if (!items.length) return <p class="chat-note muted small">{t(chat.can === "static" ? "chat.listEmptyStatic" : "chat.listEmpty")}</p>;
  return (
    <ul class="plain-list" aria-label={t("chat.conversations")}>
      {items.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            class={`rail-item${c.id === chat.state.thread ? " on" : ""}`}
            aria-current={c.id === chat.state.thread ? "true" : undefined}
            onClick={() => onPick(c.id)}
          >
            <span class="rail-title">{c.title}</span>
            <span class="rail-meta">
              {t("chat.turns", { count: c.turns })}
              {c.updatedAt ? ` · ${new Date(c.updatedAt).toLocaleDateString()}` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Question({ q, context }: { q: string; context?: ChatContext }): JSX.Element {
  const { ix, insights } = useApp();
  const about = contextLabel(ix, insights, context);
  return (
    <div class="chat-q">
      <span class="sr-only">{t("chat.you")}</span>
      <p>{q}</p>
      {about ? <p class="chat-q-ctx">{t("chat.about", { label: about })}</p> : null}
    </div>
  );
}

/** A citation that opens the node it points at (else the editor chip). */
function useCite(prefer: readonly string[]): (c: CiteRef, i: number) => JSX.Element {
  const { ix, chat } = useApp();
  const byPath = useMemo(() => nodesByPath(ix), [ix]);
  return (c, i) => {
    const id = citeNode(ix, byPath, c, prefer);
    if (!id) return <CiteChip key={i} cite={c} />;
    const where = `${c.path}:${c.line}${c.end ? `-${c.end}` : ""}`;
    const label = t("chat.citeOpen", { where, label: ix.byId.get(id)?.label ?? id });
    return (
      <button key={i} type="button" class="cite" title={label} aria-label={label} onClick={() => chat.openNode(id)}>
        {citeLabel(c)}
      </button>
    );
  };
}

interface Shown {
  question: string;
  context?: ChatContext;
  mode: "business" | "dev";
  facts: boolean;
  answer: TurnAnswer;
  followUps: string[];
  ms?: number;
  /** Instant answers: the facts are thin. */
  escalate?: boolean;
  escalated?: boolean;
  langFallback?: string;
  /** The local entry it came from (an instant answer of this page). */
  from?: string;
}

function AnswerView({ a }: { a: Shown }): JSX.Element {
  const { chat } = useApp();
  const cite = useCite(a.answer.nodes);
  const ready = chat.can === "ready";
  const asking = chat.can === "ready" || chat.can === "busy";
  return (
    <article class={`chat-a${a.facts ? " facts" : ""}`} aria-label={t(a.facts ? "chat.instantAria" : "chat.answerAria")}>
      <div class="chat-a-meta">
        {a.facts ? (
          <span class="tag tag-facts" title={t("chat.instantTitle")}>
            <Icon name="key" size={12} />
            {t("chat.instant")}
          </span>
        ) : (
          <span class="tag">{t("chat.byAgent")}</span>
        )}
        <span class="muted small">
          {t(`chat.mode.${a.mode}`)}
          {a.ms ? ` · ${t("chat.seconds", { s: num(Math.round(a.ms / 100) / 10) })}` : ""}
        </span>
      </div>
      {a.answer.answer.trim() ? <Markdown text={a.answer.answer} cite={cite} /> : <p class="muted">{t("chat.noFacts")}</p>}
      {a.langFallback ? <p class="muted small">{t("chat.langFallback")}</p> : null}
      {a.facts && a.escalate && asking && !a.escalated ? <p class="chat-escalate-why">{t("chat.escalateWhy")}</p> : null}
      <div class="chat-a-actions">
        <button type="button" class="btn btn-quiet" onClick={() => chat.show(a.answer, a.question, true)}>
          <Icon name="map" size={14} />
          {t("chat.showOnMap")}
        </button>
        {a.facts && asking && !a.escalated ? (
          <button
            type="button"
            class={`btn${a.escalate ? " btn-primary" : ""}`}
            disabled={!ready}
            onClick={() => chat.send(a.question, { ...(a.context ? { context: a.context } : {}), ...(a.from ? { from: a.from } : {}) })}
          >
            <Icon name="ask" size={14} />
            {t("chat.escalate")}
          </button>
        ) : null}
        {a.escalated ? <span class="muted small">{t("chat.escalated")}</span> : null}
      </div>
      {a.followUps.length ? (
        <div class="chat-follow" role="group" aria-label={t("chat.followUps")}>
          {a.followUps.map((f) => (
            <button key={f} type="button" class="chat-chip" disabled={!ready} title={ready ? t("chat.followUpAsk") : undefined} onClick={() => chat.send(f)}>
              {f}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function factsShown(e: LocalEntry, facts: FactsAnswer): Shown {
  return {
    question: e.question,
    ...(e.context ? { context: e.context } : {}),
    mode: e.mode,
    facts: true,
    answer: facts.answer,
    followUps: [],
    escalate: facts.escalate,
    ...(e.escalated ? { escalated: true } : {}),
    ...(facts.langFallback ? { langFallback: facts.langFallback } : {}),
    from: e.key,
  };
}

function EntryView({ e }: { e: ChatEntry }): JSX.Element {
  const { chat } = useApp();
  if (e.type === "saved") {
    const turn = e.turn;
    return (
      <li class="chat-turn">
        <Question q={turn.question} context={turn.context} />
        <AnswerView
          a={{
            question: turn.question,
            ...(turn.context ? { context: turn.context } : {}),
            mode: turn.mode,
            facts: turn.source === "facts",
            answer: turn.answer,
            followUps: turn.followUps,
            ...(turn.ms !== undefined ? { ms: turn.ms } : {}),
          }}
        />
      </li>
    );
  }
  const x = e.entry;
  return (
    <li class="chat-turn">
      <Question q={x.question} context={x.context} />
      {x.status === "facts" && x.facts ? <AnswerView a={factsShown(x, x.facts)} /> : null}
      {x.status === "pending" || x.status === "explaining" ? (
        <div class="chat-a pending">
          <span class="spinner" aria-hidden="true" />
          <span>{x.status === "explaining" ? t("chat.explaining") : x.progress ? progressLine(x.progress) : t("chat.progress.sending")}</span>
        </div>
      ) : null}
      {x.status === "error" ? (
        <div class="chat-a chat-error" role="alert">
          <p class="chat-error-head">
            <Icon name="warning" size={14} />
            {t(x.explain ? "chat.explainFailed" : "chat.failed")}
          </p>
          {x.error ? <p class="chat-error-msg">{x.error}</p> : null}
          <div class="chat-a-actions">
            {!x.explain && chat.can === "ready" ? (
              <button
                type="button"
                class="btn"
                onClick={() => {
                  chat.dismiss(x.key);
                  chat.send(x.question, x.context ? { context: x.context } : {});
                }}
              >
                <Icon name="refresh" size={14} />
                {t("chat.retry")}
              </button>
            ) : null}
            <button type="button" class="btn btn-quiet" onClick={() => chat.dismiss(x.key)}>
              {t("ask.dismiss")}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Composer({ inputRef }: { inputRef: { current: HTMLTextAreaElement | null } }): JSX.Element {
  const { chat, state, ix, insights } = useApp();
  const [q, setQ] = useState("");
  const draft = chat.state.draft;
  const about = contextLabel(ix, insights, draft);
  const can = chat.can;
  if (can === "static" || can === "noagent") {
    const prompt = promptFor(ix, insights, draft);
    return (
      <div class="chat-readonly">
        {about ? <p class="chat-ctx-line">{t("chat.about", { label: about })}</p> : null}
        <p class="muted small">{t(can === "static" ? "chat.readOnly" : "chat.noAgent")}</p>
        <p>
          <code class="cmd">{can === "static" ? "ultraview serve --open" : "ultraview serve --ask auto"}</code>
        </p>
        {prompt ? <CopyButton text={prompt} label={t("chat.copyPrompt")} message={t("toast.promptCopied")} icon="copy" /> : null}
      </div>
    );
  }
  const ok = can === "ready" && questionOk(q);
  const submit = (e: Event) => {
    e.preventDefault();
    if (!ok) return;
    chat.send(q, draft ? { context: draft } : {});
    setQ("");
  };
  return (
    <form class="chat-compose" onSubmit={submit} aria-busy={can === "busy"}>
      {about ? (
        <div class="chat-ctx">
          <span class="chat-ctx-label">{t("chat.about", { label: about })}</span>
          <button type="button" class="icon-btn small" aria-label={t("chat.clearContext")} title={t("chat.clearContext")} onClick={() => chat.setDraft()}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}
      <label class="sr-only" for="chat-q">
        {t("chat.label")}
      </label>
      <textarea
        id="chat-q"
        ref={inputRef}
        rows={2}
        value={q}
        maxLength={QUESTION_MAX}
        placeholder={about ? t("chat.placeholderAbout", { label: about }) : t("chat.placeholder")}
        aria-describedby="chat-hint"
        onInput={(e) => setQ((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) submit(e);
        }}
      />
      <div class="chat-compose-row">
        <span id="chat-hint" class="muted small">
          {can === "busy" ? t("chat.busyHint") : t("chat.hint", { mode: t(`audience.${state.audience}`) })}
        </span>
        <button type="submit" class="btn btn-primary" disabled={!ok}>
          {can === "busy" ? <span class="spinner" aria-hidden="true" /> : null}
          {t("chat.send")}
        </button>
      </div>
    </form>
  );
}
