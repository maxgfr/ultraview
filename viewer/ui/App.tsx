// The app shell: state, deep links, settings, live data, and the views.

import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { normalizeChanges, normalizeInsights, timelineViews } from "../lib/changes.js";
import { buildIndex } from "../lib/data.js";
import { EDITORS, type Editor, type RepoRef } from "../lib/editor.js";
import { detectLang, LANGS, type Lang, setLang, t } from "../lib/i18n.js";
import { locate } from "../lib/levels.js";
import { defaultAudience, drillTarget, levelAllowed, revealTarget } from "../lib/nav.js";
import { formatHash, parseHash, type Route } from "../lib/route.js";
import { searchDocs } from "../lib/search.js";
import type { ViewModel } from "../../src/model/types.js";
import { type AppApi, AppContext, type NavMode, type Settings, type UiState } from "./context.js";
import { Icon } from "./icons.js";
import { forgetLayoutsBefore } from "./layout.js";
import { startLive } from "./live.js";
import { MapView, sceneFor } from "./MapView.js";
import { Search } from "./Search.js";
import { SidePanel } from "./SidePanel.js";
import { TopBar } from "./TopBar.js";
import { Tour } from "./Tour.js";
import { ChangesView, DataModelsView, FlowsView, InsightsView, LensesView } from "./Views.js";

const SETTINGS_KEY = "ultraview.settings";

function loadSettings(): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    stored = {};
  }
  const navLangs = typeof navigator !== "undefined" ? [...(navigator.languages ?? []), navigator.language].filter(Boolean) : [];
  return {
    ...(stored.theme === "light" || stored.theme === "dark" ? { theme: stored.theme } : {}),
    lang: detectLang((LANGS as readonly string[]).includes(stored.lang ?? "") ? (stored.lang as Lang) : null, navLangs),
    editor: (EDITORS as readonly string[]).includes(stored.editor ?? "") ? (stored.editor as Editor) : "vscode",
  };
}

function useMedia(query: string): boolean {
  const get = () => typeof matchMedia === "function" && matchMedia(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return match;
}

function routeOf(s: UiState): Route {
  const r: Route = { view: s.view };
  if (s.view === "map") {
    r.level = s.map.level;
    if (s.map.focus) r.focus = s.map.focus;
  }
  if (s.view === "lenses" && s.lens) r.lens = s.lens;
  if (s.view === "flows" && s.flow) {
    r.flow = s.flow;
    r.step = s.step + 1;
  }
  if (s.view === "changes" && s.change) r.change = s.change;
  if (s.selected) r.node = s.selected;
  return r;
}

function applyRoute(s: UiState, r: Route, ix: ReturnType<typeof buildIndex>): UiState {
  let map = s.map;
  let audience = s.audience;
  if (r.view === "map") {
    if (r.level) {
      const same = r.level === s.map.level && r.focus === s.map.focus;
      map = { level: r.level, ...(r.focus ? { focus: r.focus } : {}), ...(same && s.map.expanded ? { expanded: s.map.expanded } : {}) };
    } else if (r.node && ix.byId.has(r.node)) map = revealTarget(ix, r.node);
    if (!levelAllowed(map.level, audience)) audience = "developer";
  }
  return {
    ...s,
    view: r.view,
    map,
    audience,
    selected: r.node,
    lens: r.lens,
    flow: r.flow,
    step: Math.max(0, (r.step ?? 1) - 1),
    change: r.change,
    panelOpen: !!r.node,
    ...(r.node ? { center: { id: r.node, nonce: Date.now() } } : {}),
  };
}

const RANK: Record<NavMode, number> = { none: 0, replace: 1, push: 2 };

export function App({ initial, repo }: { initial: ViewModel; repo: RepoRef }): JSX.Element {
  const [data, setData] = useState({ view: initial, version: 1 });
  const ix = useMemo(() => buildIndex(data.view), [data]);
  const docs = useMemo(() => searchDocs(ix), [ix]);
  const changes = useMemo(() => [...normalizeChanges(ix.view.changes), ...timelineViews(ix.view.timeline)], [ix]);
  const insights = useMemo(() => normalizeInsights(ix.view.insights), [ix]);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  setLang(settings.lang);
  const narrow = useMedia("(max-width: 599px)");
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);

  const [state, setState] = useState<UiState>(() =>
    applyRoute(
      {
        view: "map",
        map: { level: "biz" },
        step: 0,
        audience: defaultAudience(initial.app?.audience),
        listMode: false,
        panelOpen: false,
        searchOpen: false,
      },
      parseHash(typeof location !== "undefined" ? location.hash : ""),
      ix,
    ),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const nav = useRef<NavMode>("none");

  const update = useCallback<AppApi["update"]>((patch, mode = "replace") => {
    if (RANK[mode] > RANK[nav.current]) nav.current = mode;
    setState((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
  }, []);

  // Deep links: the hash follows the state; navigation pushes, the rest replaces.
  useEffect(() => {
    const mode = nav.current;
    nav.current = "none";
    const hash = formatHash(routeOf(state));
    const current = location.hash === "#" ? "" : location.hash;
    if (hash === current) return;
    const url = `${location.pathname}${location.search}${hash || "#"}`;
    try {
      if (mode === "push") history.pushState(null, "", url);
      else history.replaceState(null, "", url);
    } catch {
      // some file:// contexts refuse history writes; the app still works
    }
  }, [state]);
  useEffect(() => {
    const onPop = () => setState((s) => applyRoute(s, parseHash(location.hash), ix));
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, [ix]);

  // Settings: persisted, applied to the document.
  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // private mode: settings last for the session
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme) el.dataset.theme = settings.theme;
    else delete el.dataset.theme;
    el.lang = settings.lang;
  }, [settings.theme, settings.lang]);
  useEffect(() => {
    document.title = `${ix.view.app.name} · ultraview`;
  }, [ix]);

  // Live data (served by `ultraview serve`): swap the view in place, keep camera and selection.
  useEffect(
    () =>
      startLive((view) =>
        setData((d) => {
          forgetLayoutsBefore(d.version + 1);
          return { view, version: d.version + 1 };
        }),
      ),
    [],
  );

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 2600);
  }, []);
  const copy = useCallback(
    (text: string, message: string) => {
      const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        ta.remove();
        toast(ok ? message : t("toast.copyFailed"));
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(message), fallback);
      else fallback();
    },
    [toast],
  );

  const select = useCallback((id: string | undefined) => update({ selected: id, panelOpen: !!id }, "replace"), [update]);

  const reveal = useCallback<AppApi["reveal"]>(
    (id, spotlight, mode = "push") => {
      const s = stateRef.current;
      if (!ix.byId.has(id)) return;
      let map = s.map;
      let audience = s.audience;
      const drawn = s.view === "map" ? locate(ix, sceneFor(ix, data.version, s.map, s.audience), id) : undefined;
      if (drawn !== id) {
        map = revealTarget(ix, id);
        if (!levelAllowed(map.level, audience)) {
          audience = "developer";
          toast(t("toast.switchedDev"));
        }
      }
      update({ view: "map", map, audience, selected: id, panelOpen: true, spotlight, center: { id, nonce: Date.now() } }, mode);
    },
    [ix, data.version, update, toast],
  );

  const drill = useCallback(
    (id: string) => {
      const s = stateRef.current;
      const realId = id.startsWith("cluster:") ? id.slice(8) : id;
      const n = ix.byId.get(realId);
      if (n?.kind === "file" && s.map.level === "file" && !id.startsWith("cluster:")) {
        const open = new Set(s.map.expanded ?? []);
        if (open.has(realId)) open.delete(realId);
        else if (ix.children.get(realId)?.length) open.add(realId);
        else {
          select(realId);
          return;
        }
        update({ map: { ...s.map, expanded: [...open].sort() }, selected: realId, panelOpen: true }, "replace");
        return;
      }
      const target = drillTarget(ix, realId);
      if (!target) {
        select(realId);
        return;
      }
      if (!levelAllowed(target.level, s.audience)) {
        toast(t("toast.developerOnly"));
        select(realId);
        return;
      }
      update({ map: target, selected: realId, spotlight: undefined }, "push");
    },
    [ix, update, select, toast],
  );

  // Global keys: ⌘K / Ctrl+K and "/" open search; Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        update((s) => ({ searchOpen: !s.searchOpen }));
      } else if (e.key === "/" && !typing && !stateRef.current.searchOpen) {
        e.preventDefault();
        update({ searchOpen: true });
      } else if (e.key === "Escape" && !typing && !stateRef.current.searchOpen && stateRef.current.tour === undefined && stateRef.current.panelOpen) {
        update({ panelOpen: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [update]);

  const api: AppApi = {
    ix,
    version: data.version,
    repo: { ...repo, ...(ix.view.repo.remote ? { remote: ix.view.repo.remote } : {}), ...(ix.view.repo.commit ? { commit: ix.view.repo.commit } : {}) },
    state,
    settings,
    narrow,
    docs,
    changes,
    insights,
    update,
    setSettings,
    toast,
    copy,
    select,
    reveal,
    drill,
  };

  const View = { map: MapView, data: DataModelsView, flows: FlowsView, lenses: LensesView, changes: ChangesView, insights: InsightsView }[state.view];
  const selectedNode = state.selected ? ix.byId.get(state.selected) : undefined;
  return (
    <AppContext.Provider value={api}>
      <div class={`app${narrow ? " narrow" : ""}`}>
        <a class="skip" href="#main">
          {t("top.skip")}
        </a>
        <TopBar />
        <div class="body">
          <main id="main" class="main" tabIndex={-1} aria-label={t(`view.${state.view}`)}>
            <View />
          </main>
          <SidePanel />
          {selectedNode && !state.panelOpen ? (
            <button type="button" class="panel-reopen btn" onClick={() => update({ panelOpen: true })}>
              <Icon name="chevronLeft" size={14} />
              {t("panel.reopen", { label: selectedNode.label })}
            </button>
          ) : null}
        </div>
        <Tour />
        <Search />
        <div class="toasts" role="status" aria-live="polite">
          {toasts.map((x) => (
            <div key={x.id} class="toast">
              {x.text}
            </div>
          ))}
        </div>
      </div>
    </AppContext.Provider>
  );
}

/** Shown when the page carries no map data. */
export function NoData(): JSX.Element {
  setLang(loadSettings().lang);
  return (
    <div class="empty full">
      <Icon name="map" size={32} />
      <h1>{t("nodata.title")}</h1>
      <p>{t("nodata.body")}</p>
      <p>
        <code class="cmd">ultraview build</code> <code class="cmd">ultraview render</code>
      </p>
    </div>
  );
}
