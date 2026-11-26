// The top bar: app name and summary, views, audience, Start here, search,
// settings (editor), theme and language.

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { EDITORS, type Editor } from "../lib/editor.js";
import { type Lang, LANGS, t } from "../lib/i18n.js";
import { stripCites } from "../lib/markdown.js";
import { VIEWS, type ViewName } from "../lib/route.js";
import { useApp } from "./context.js";
import { Icon } from "./icons.js";

const VIEW_ICON: Record<ViewName, string> = { map: "map", data: "data", flows: "flow", lenses: "lens", changes: "changes", insights: "insights" };

function counts(api: ReturnType<typeof useApp>): Partial<Record<ViewName, number>> {
  const v = api.ix.view;
  return {
    data: v.nodes.filter((n) => n.kind === "entity").length,
    flows: v.flows?.length ?? 0,
    lenses: v.lenses?.length ?? 0,
    changes: api.changes.length,
    insights: api.insights.length,
  };
}

function SettingsMenu({ onClose }: { onClose: () => void }): JSX.Element {
  const { settings, setSettings, repo } = useApp();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !(e.target as Element)?.closest?.(".settings-btn")) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  return (
    <div
      class="popover"
      ref={root}
      role="dialog"
      aria-label={t("settings.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <fieldset>
        <legend>{t("settings.editor")}</legend>
        {EDITORS.map((ed) => (
          <label key={ed} class="radio">
            <input type="radio" name="editor" value={ed} checked={settings.editor === ed} onChange={() => setSettings({ editor: ed as Editor })} />
            {t(`editor.${ed}`)}
          </label>
        ))}
      </fieldset>
      <p class="muted small">
        {!repo.root && !repo.remote
          ? t("settings.noRepo")
          : settings.editor === "github" && !repo.remote
            ? t("settings.noRemote")
            : !repo.root
              ? t("settings.noRoot")
              : t("settings.editorHint")}
      </p>
    </div>
  );
}

export function TopBar(): JSX.Element {
  const api = useApp();
  const { ix, state, update, settings, setSettings } = api;
  const [menu, setMenu] = useState(false);
  const [sumOpen, setSumOpen] = useState(false);
  const n = counts(api);
  const summary = ix.view.app.summary ? stripCites(ix.view.app.summary) : "";
  const tour = ix.view.tour ?? [];
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const dark = settings.theme ? settings.theme === "dark" : typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

  return (
    <header class="top">
      <div class="brand">
        <h1 class="app-name" title={ix.view.app.name}>
          {ix.view.app.name}
        </h1>
        {summary ? (
          <button
            type="button"
            class={`app-sum${sumOpen ? " open" : ""}`}
            aria-expanded={sumOpen}
            title={sumOpen ? t("top.summaryLess") : t("top.summaryMore")}
            onClick={() => setSumOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && sumOpen) {
                e.stopPropagation();
                setSumOpen(false);
              }
            }}
          >
            {summary}
          </button>
        ) : null}
      </div>
      <nav class="views" aria-label={t("top.views")}>
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            class={`view-tab${state.view === v ? " on" : ""}`}
            aria-current={state.view === v ? "page" : undefined}
            aria-label={n[v] ? `${t(`view.${v}`)} (${n[v]})` : t(`view.${v}`)}
            title={t(`view.${v}`)}
            onClick={() => update({ view: v, tour: undefined }, "push")}
          >
            <Icon name={VIEW_ICON[v]} size={14} />
            <span class="view-label" aria-hidden="true">
              {t(`view.${v}`)}
            </span>
            {n[v] ? (
              <span class="count" aria-hidden="true">
                {n[v]}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      <div class="top-actions">
        {tour.length ? (
          <button
            type="button"
            class="btn btn-primary"
            title={t("top.startHere")}
            aria-label={t("top.startHere")}
            onClick={() => update({ tour: 0, view: "map" }, "push")}
          >
            <Icon name="play" size={12} />
            <span class="start-label">{t("top.startHere")}</span>
          </button>
        ) : null}
        <div class="seg small" role="radiogroup" aria-label={t("top.audience")}>
          {(["business", "developer"] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={state.audience === a}
              class={state.audience === a ? "on" : ""}
              onClick={() =>
                update(
                  (s) => ({ audience: a, map: a === "business" && (s.map.level === "file" || s.map.level === "sym") ? { level: "mod" } : s.map }),
                  "replace",
                )
              }
            >
              {t(`audience.${a}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="search-btn"
          title={t("top.search")}
          aria-label={t("top.search")}
          onClick={() => update({ searchOpen: true })}
          aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        >
          <Icon name="search" size={14} />
          <span>{t("top.search")}</span>
          <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div class="menu-wrap">
          <button
            type="button"
            class="icon-btn settings-btn"
            aria-label={t("settings.title")}
            title={t("settings.title")}
            aria-expanded={menu}
            aria-haspopup="dialog"
            onClick={() => setMenu((m) => !m)}
          >
            <Icon name="gear" />
          </button>
          {menu ? <SettingsMenu onClose={() => setMenu(false)} /> : null}
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label={dark ? t("top.lightTheme") : t("top.darkTheme")}
          title={dark ? t("top.lightTheme") : t("top.darkTheme")}
          onClick={() => setSettings({ theme: dark ? "light" : "dark" })}
        >
          <Icon name={dark ? "sun" : "moon"} />
        </button>
        <label class="lang">
          <span class="sr-only">{t("top.language")}</span>
          <select value={settings.lang} onChange={(e) => setSettings({ lang: (e.target as HTMLSelectElement).value as Lang })}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}
