// ⌘K: find any node by label, id or path; results grouped by kind, arrow
// keys to move, Enter to select and reveal it on the map at the right level.
// When `ultraview serve` runs the Ask bridge, the last option asks the typed
// text as a question ("Ask: …") in the chat panel.

import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n.js";
import { nodeLabels } from "../lib/labels.js";
import { questionOk } from "../lib/live.js";
import { groupHits, type Hit, search } from "../lib/search.js";
import { useApp } from "./context.js";
import { kindName } from "./format.js";
import { Icon } from "./icons.js";

export function Search(): JSX.Element | null {
  const { ix, docs, state, update, reveal, chat, live } = useApp();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const hits = useMemo(() => search(docs, q, 60), [docs, q]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  const flat: Hit[] = groups.flatMap((g) => g.hits);
  const mode = chat.can;
  // The "Ask: …" option, after the hits: shown while the bridge is on, usable when it is idle.
  const askable = (mode === "ready" || mode === "busy") && questionOk(q);
  const askIndex = askable ? flat.length : -1;
  const options = flat.length + (askable ? 1 : 0);
  const labels = useMemo(
    () =>
      nodeLabels(
        ix,
        hits.map((h) => h.id),
      ),
    [ix, hits],
  );

  useEffect(() => {
    if (state.searchOpen) {
      opener.current = document.activeElement;
      setQ("");
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    } else if (opener.current instanceof HTMLElement) opener.current.focus();
  }, [state.searchOpen]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    document.getElementById(`sr-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!state.searchOpen) return null;
  const close = () => update({ searchOpen: false });
  const choose = (h: Hit | undefined) => {
    if (!h) return;
    update({ searchOpen: false });
    reveal(h.id);
  };
  const askIt = () => {
    if (mode !== "ready") return;
    update({ searchOpen: false });
    chat.open();
    chat.send(q);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(options - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter") {
      if (active === askIndex) askIt();
      else choose(flat[active]);
    } else if (e.key === "Escape") close();
    else if (e.key === "Tab") {
      // keep focus in the dialog: the input is its only control
    } else return;
    e.preventDefault();
  };
  let i = -1;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop is a mouse shortcut; keyboards close with Esc in the input
    <div class="scrim" role="presentation" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="search" role="dialog" aria-modal="true" aria-label={t("search.title")}>
        <div class="search-input">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded={options > 0}
            aria-controls="search-results"
            aria-activedescendant={options ? `sr-${active}` : undefined}
            aria-autocomplete="list"
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={onKey}
            spellcheck={false}
            autocomplete="off"
          />
          <kbd>Esc</kbd>
        </div>
        <div class="search-results" id="search-results" role="listbox" aria-label={t("search.results")}>
          {q && !flat.length ? <p class="search-empty">{t("search.none", { q })}</p> : null}
          {!q ? <p class="search-empty">{t("search.hint")}</p> : null}
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-label={kindName(g.kind)}>
              <div class="search-group" aria-hidden="true">
                {kindName(g.kind)}
              </div>
              {g.hits.map((h) => {
                i++;
                const idx = i;
                return (
                  <div
                    key={h.id}
                    id={`sr-${idx}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={idx === active}
                    class={`search-hit${idx === active ? " on" : ""}`}
                    onMouseMove={() => setActive(idx)}
                    onClick={() => choose(h)}
                    onKeyDown={onKey}
                  >
                    <Icon name={h.kind} size={14} />
                    <span class="hit-label">{labels.get(h.id) ?? h.label}</span>
                    {h.path && state.audience === "developer" ? <span class="hit-path">{h.path}</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {askable ? (
            <div role="group" aria-label={t("search.askGroup")}>
              <div class="search-group" aria-hidden="true">
                {t("search.askGroup")}
              </div>
              <div
                id={`sr-${askIndex}`}
                role="option"
                tabIndex={-1}
                aria-selected={active === askIndex}
                aria-disabled={mode !== "ready"}
                class={`search-hit search-ask${active === askIndex ? " on" : ""}${mode !== "ready" ? " disabled" : ""}`}
                onMouseMove={() => setActive(askIndex)}
                onClick={askIt}
                onKeyDown={onKey}
              >
                <Icon name="ask" size={14} />
                <span class="hit-label">{t("search.ask", { q: q.trim() })}</span>
                <span class="hit-path">{mode === "ready" ? t("search.askHint", { agent: live.ask?.agent ?? "" }) : t("ask.busy")}</span>
              </div>
            </div>
          ) : null}
        </div>
        <div class="search-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("search.move")}
          </span>
          <span>
            <kbd>↵</kbd> {t("search.open")}
          </span>
        </div>
      </div>
    </div>
  );
}
