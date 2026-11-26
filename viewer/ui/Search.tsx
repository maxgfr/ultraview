// ⌘K: find any node by label, id or path; results grouped by kind, arrow
// keys to move, Enter to select and reveal it on the map at the right level.

import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n.js";
import { nodeLabels } from "../lib/labels.js";
import { groupHits, type Hit, search } from "../lib/search.js";
import { useApp } from "./context.js";
import { kindName } from "./format.js";
import { Icon } from "./icons.js";

export function Search(): JSX.Element | null {
  const { ix, docs, state, update, reveal } = useApp();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const hits = useMemo(() => search(docs, q, 60), [docs, q]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  const flat: Hit[] = groups.flatMap((g) => g.hits);
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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(flat.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter") choose(flat[active]);
    else if (e.key === "Escape") close();
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
            aria-expanded={flat.length > 0}
            aria-controls="search-results"
            aria-activedescendant={flat.length ? `sr-${active}` : undefined}
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
