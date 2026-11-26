// The live affordances of a served map (docs/design.md §8): the "code
// changed" banner when the index went stale, and the Ask box that sends a
// question to the user's agent through `ultraview serve` and opens the saved
// answer as a lens. Both render nothing on a static page.

import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { num, t } from "../lib/i18n.js";
import { type AskRun, askMode, QUESTION_MAX, questionOk, showStale, staleCount } from "../lib/live.js";
import { useApp } from "./context.js";
import { Icon } from "./icons.js";

/** A non-blocking strip under the top bar: the map is older than the code. */
export function StaleBanner(): JSX.Element | null {
  const { live, dismissLive } = useApp();
  if (!showStale(live) || !live.stale) return null;
  const n = staleCount(live.stale);
  const files = live.stale.files;
  return (
    <div class="live-banner" role="status">
      <Icon name="warning" size={14} />
      <span>
        {n ? t("live.stale", { count: n, n: num(n) }) : t("live.staleNoCount")} <code class="cmd">ultraview build</code>
      </span>
      {files.length ? (
        <span class="live-files" title={files.join("\n")}>
          {files.slice(0, 3).join(", ")}
          {files.length > 3 || n > 3 ? "…" : ""}
        </span>
      ) : null}
      <button type="button" class="icon-btn small" aria-label={t("live.dismiss")} title={t("live.dismiss")} onClick={() => dismissLive("stale")}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** The live sentence for a run (also read out by the status region). */
export function runText(run: AskRun | undefined, busy: boolean): string {
  if (!run) return busy ? t("ask.busy") : "";
  if (!run.mine) return t("ask.other", { question: run.question });
  const agent = run.agent ?? t("ask.yourAgent");
  switch (run.stage) {
    case "sending":
      return t("ask.stage.sending");
    case "started":
      return t("ask.stage.started", { agent });
    case "running":
      return run.bytes ? t("ask.stage.runningBytes", { agent, kb: num(Math.max(1, Math.round(run.bytes / 1024))) }) : t("ask.stage.running", { agent });
    case "validating":
      return t("ask.stage.validating");
    default:
      return "";
  }
}

/** Ask a question; the answer comes back as a saved, cited lens. */
export function AskBox(): JSX.Element | null {
  const { live, ask, dismissLive } = useApp();
  const [q, setQ] = useState("");
  const mode = askMode(live);
  if (mode === "off" || !live.ask) return null;
  const busy = mode === "busy";
  const run = live.run;
  const status = runText(run, busy);
  const submit = (e: Event) => {
    e.preventDefault();
    if (busy || !questionOk(q)) return;
    ask(q);
    setQ("");
  };
  return (
    <form class="ask-box" onSubmit={submit} aria-busy={busy}>
      <label class="ask-label" for="ask-q">
        <Icon name="ask" size={14} />
        {t("ask.label", { agent: live.ask.agent })}
      </label>
      <div class="ask-row">
        <input
          id="ask-q"
          type="text"
          value={q}
          maxLength={QUESTION_MAX}
          placeholder={t("ask.placeholder")}
          disabled={busy}
          autocomplete="off"
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn btn-primary" disabled={busy || !questionOk(q)}>
          {busy ? <span class="spinner" aria-hidden="true" /> : null}
          {t("ask.submit")}
        </button>
      </div>
      {run?.mine ? <p class="ask-q">{run.question}</p> : null}
      <p class="ask-status muted small" role="status" aria-live="polite">
        {status}
      </p>
      {live.error ? (
        <div class="ask-error" role="alert">
          <p>
            <Icon name="warning" size={14} />
            <span>{live.error.question ? t("ask.failed", { question: live.error.question }) : t("ask.failedNoQuestion")}</span>
          </p>
          {live.error.error ? <p class="ask-error-msg">{live.error.error}</p> : null}
          {live.error.problems.length ? (
            <ul class="ask-problems">
              {live.error.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <button type="button" class="btn btn-quiet" onClick={() => dismissLive("error")}>
            {t("ask.dismiss")}
          </button>
        </div>
      ) : null}
    </form>
  );
}
