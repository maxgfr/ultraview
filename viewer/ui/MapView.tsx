// The Map: level switcher, the semantic-zoom graph (or its accessible list),
// breadcrumb, legend, the "show all" affordance for views grouped by folder,
// the open-aggregate, change overlay and spotlight banners, and the Business
// empty state of a map without a business model.

import type { JSX } from "preact";
import { useMemo, useRef } from "preact/hooks";
import { normalizeChanges, type OverlayKind } from "../lib/changes.js";
import type { Index } from "../lib/data.js";
import { t } from "../lib/i18n.js";
import {
  buildScene,
  type FreeKind,
  GROUP_LIMIT,
  type Level,
  levelsFor,
  locate,
  type MapState,
  type Scene,
  type SceneNode,
  sceneKey,
  type ViewerAudience,
} from "../lib/levels.js";
import { breadcrumb } from "../lib/nav.js";
import { businessMapPrompt } from "../lib/prompts.js";
import { useApp } from "./context.js";
import { Graph, graphCommand } from "./Graph.js";
import { Icon } from "./icons.js";
import { perfStart, perfTime } from "./perf.js";
import { SceneList } from "./SceneList.js";

const sceneCache = new Map<string, Scene>();

/** The scene of a map state, memoised per data version. */
export function sceneFor(ix: Index, version: number, map: MapState, audience: ViewerAudience): Scene {
  const key = `${version}\n${sceneKey(map, audience)}`;
  const hit = sceneCache.get(key);
  if (hit) return hit;
  const s = perfTime("scene", () => buildScene(ix, map, audience));
  if (sceneCache.size > 64) sceneCache.clear();
  sceneCache.set(key, s);
  return s;
}

/** Scene ids lit by a set of view-model ids. */
export function spotIds(ix: Index, scene: Scene, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const s = locate(ix, scene, id);
    if (s) out.add(s);
  }
  return out;
}

const EDGE_LEGEND = ["call", "import", "uses", "http", "data", "event", "queue", "extends", "config"] as const;
const FREE_KINDS: readonly FreeKind[] = ["entity", "ext", "infra"];

/** Business without a business map: what it would show, and the prompt that writes it. */
function BusinessEmpty({ onSystems }: { onSystems: () => void }): JSX.Element {
  const { ix, copy } = useApp();
  const prompt = businessMapPrompt(ix.view.app.name);
  return (
    <div class="empty biz-empty">
      <Icon name="cap" size={28} />
      <h2>{t("biz.emptyTitle")}</h2>
      <p>{t("biz.emptyBody")}</p>
      <p class="muted small">{t("biz.emptyHow")}</p>
      <pre class="prompt-box">{prompt}</pre>
      <div class="empty-actions">
        <button type="button" class="btn btn-primary" onClick={() => copy(prompt, t("toast.promptCopied"))}>
          <Icon name="copy" size={14} />
          {t("biz.copyPrompt")}
        </button>
        <button type="button" class="btn" onClick={onSystems}>
          <Icon name="sys" size={14} />
          {t("biz.openSystems")}
        </button>
      </div>
    </div>
  );
}

export function Legend({ scene }: { scene: Scene }): JSX.Element | null {
  const kinds = new Set(scene.edges.map((e) => e.kind));
  const shown = EDGE_LEGEND.filter((k) => kinds.has(k));
  if (!shown.length) return null;
  return (
    <ul class="legend" aria-label={t("map.legend")}>
      {shown.map((k) => (
        <li key={k}>
          <svg width="28" height="10" aria-hidden="true" class={`legend-line k-${k}`}>
            {k === "event" || k === "queue" ? <line class="e-under" x1="1" x2="27" y1="5" y2="5" /> : null}
            <line class="e-line" x1="1" x2="27" y1="5" y2="5" />
          </svg>
          {t(`edge.${k}`)}
        </li>
      ))}
    </ul>
  );
}

export function MapView(): JSX.Element {
  const api = useApp();
  const { ix, version, state, update, select, drill, changes } = api;
  const root = useRef<HTMLDivElement>(null);
  const scene = useMemo(() => sceneFor(ix, version, state.map, state.audience), [ix, version, state.map, state.audience]);
  const levels = levelsFor(state.audience);
  const crumbs = breadcrumb(ix, state.map);

  const selected = state.selected ? locate(ix, scene, state.selected) : undefined;
  const spotlight = useMemo(() => (state.spotlight ? spotIds(ix, scene, state.spotlight.ids) : undefined), [scene, state.spotlight]);
  const overlayView = useMemo(() => {
    if (!state.overlay) return undefined;
    return [...normalizeChanges(ix.view.changes), ...changes].find((c) => c.id === state.overlay);
  }, [state.overlay, changes, ix]);
  const overlay = useMemo(() => {
    if (!overlayView) return undefined;
    const m = new Map<string, OverlayKind>();
    const rank: Record<OverlayKind, number> = { removed: 0, new: 1, changed: 2, impacted: 3 };
    for (const it of overlayView.items) {
      const s = locate(ix, scene, it.ref);
      if (!s) continue;
      const prev = m.get(s);
      if (!prev || rank[it.change] < rank[prev]) m.set(s, it.change);
    }
    return m;
  }, [overlayView, scene]);
  const center = state.center ? { id: locate(ix, scene, state.center.id) ?? state.center.id, nonce: state.center.nonce } : undefined;

  const setLevel = (level: Level) => {
    perfStart(`level ${state.map.level} → ${level}`);
    update({ map: { level }, spotlight: undefined }, "push");
  };
  const openGroup = (group: string) => {
    perfStart(`open folder ${group}`);
    update(
      {
        map: { level: state.map.level, ...(state.map.focus ? { focus: state.map.focus } : {}), group, ...(state.map.open ? { open: state.map.open } : {}) },
        selected: undefined,
        spotlight: undefined,
      },
      "push",
    );
  };
  const setOpen = (kind: FreeKind, on: boolean) => {
    const open = new Set(state.map.open ?? []);
    if (on) open.add(kind);
    else open.delete(kind);
    perfStart(`${on ? "open" : "close"} ${kind}`);
    update({ map: { ...state.map, open: [...open].sort() } }, "replace");
  };
  const onActivate = (n: SceneNode) => {
    if (n.role === "ghost") api.reveal(n.ref);
    else if (n.role === "cluster" && n.group !== undefined) openGroup(n.group);
    else if (n.role === "agg") {
      if (n.kind === "entity") update({ view: "data", selected: undefined, spotlight: undefined }, "push");
      else setOpen(n.kind as FreeKind, true);
    } else drill(n.id);
  };
  // Folder cards and aggregate chips stand for many nodes: selecting one opens it.
  const onSelect = (n: SceneNode | undefined) => (n && (n.role === "agg" || (n.role === "cluster" && n.group !== undefined)) ? onActivate(n) : select(n?.ref));
  const showList = state.listMode || api.narrow;
  const openKinds = FREE_KINDS.filter((k) => state.map.open?.includes(k));
  const bizEmpty = state.map.level === "biz" && !ix.hasBusiness && !state.map.focus;

  return (
    <div class="map" ref={root}>
      <div class="map-tools">
        <div class="seg" role="radiogroup" aria-label={t("map.level")}>
          {levels.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={state.map.level === l && !state.map.focus}
              class={state.map.level === l ? "on" : ""}
              onClick={() => setLevel(l)}
            >
              {t(`level.${l}`)}
            </button>
          ))}
        </div>
        <div class="map-tools-right">
          {!showList && !bizEmpty ? (
            <>
              <button type="button" class="icon-btn" aria-label={t("map.zoomOut")} title={t("map.zoomOut")} onClick={() => graphCommand(root.current, "out")}>
                <Icon name="minus" />
              </button>
              <button type="button" class="icon-btn" aria-label={t("map.zoomIn")} title={t("map.zoomIn")} onClick={() => graphCommand(root.current, "in")}>
                <Icon name="plus" />
              </button>
              <button type="button" class="icon-btn" aria-label={t("map.fit")} title={t("map.fit")} onClick={() => graphCommand(root.current, "fit")}>
                <Icon name="fit" />
              </button>
            </>
          ) : null}
          {!api.narrow ? (
            <button
              type="button"
              class={`btn btn-quiet${state.listMode ? " on" : ""}`}
              aria-pressed={state.listMode}
              onClick={() => update({ listMode: !state.listMode })}
            >
              <Icon name={state.listMode ? "map" : "list"} size={14} />
              {state.listMode ? t("map.showDrawing") : t("map.showList")}
            </button>
          ) : null}
        </div>
      </div>

      {(scene.grouped || state.map.showAll || openKinds.length || scene.edgesTotal > scene.edges.length || state.spotlight || overlayView) && !bizEmpty ? (
        <div class="banners">
          {scene.grouped ? (
            <div class="banner" role="status">
              <Icon name="folder" size={14} />
              <span>{t("map.grouped", { count: scene.total, limit: GROUP_LIMIT })}</span>
              <button type="button" class="link" onClick={() => update({ map: { ...state.map, showAll: true } }, "replace")}>
                {t("map.showAll")}
              </button>
            </div>
          ) : state.map.showAll && scene.total > GROUP_LIMIT ? (
            <div class="banner" role="status">
              <span>{t("map.showingAll", { count: scene.total })}</span>
              <button type="button" class="link" onClick={() => update({ map: { ...state.map, showAll: false } }, "replace")}>
                {t("map.regroup")}
              </button>
            </div>
          ) : null}
          {openKinds.map((k) => (
            <div key={k} class="banner" role="status">
              <Icon name={k} size={14} />
              <span>{t(`map.open.${k}`)}</span>
              <button type="button" class="link" onClick={() => setOpen(k, false)}>
                {t("map.regroup")}
              </button>
            </div>
          ))}
          {scene.edgesTotal > scene.edges.length ? (
            <div class="banner" role="status">
              <span>{t("map.edgesCapped", { shown: scene.edges.length, total: scene.edgesTotal })}</span>
              {!scene.grouped ? (
                <button type="button" class="link" onClick={() => update({ map: { ...state.map, showAll: true } }, "replace")}>
                  {t("map.showAllLinks")}
                </button>
              ) : null}
            </div>
          ) : null}
          {state.spotlight ? (
            <div class="banner banner-accent" role="status">
              <span>{state.spotlight.label}</span>
              <button
                type="button"
                class="icon-btn small"
                aria-label={t("map.clearSpot")}
                title={t("map.clearSpot")}
                onClick={() => update({ spotlight: undefined })}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}
          {overlayView ? (
            <div class="banner banner-accent" role="status">
              <span>{t("map.overlay", { title: overlayView.title })}</span>
              <span class="ov-legend" aria-hidden="true">
                {(["new", "changed", "removed", "impacted"] as const).map((k) => (
                  <span key={k} class={`ov-key ov-${k}`}>
                    {t(`change.${k}`)}
                  </span>
                ))}
              </span>
              <button
                type="button"
                class="icon-btn small"
                aria-label={t("map.clearOverlay")}
                title={t("map.clearOverlay")}
                onClick={() => update({ overlay: undefined })}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div class="map-canvas">
        {bizEmpty ? (
          <BusinessEmpty onSystems={() => setLevel("sys")} />
        ) : showList ? (
          <SceneList scene={scene} selected={selected} onSelect={onSelect} onActivate={onActivate} />
        ) : scene.nodes.length ? (
          <Graph
            scene={scene}
            label={t("map.aria", { level: t(`level.${state.map.level}`) })}
            selected={selected}
            spotlight={spotlight}
            overlay={overlay}
            center={center}
            onSelect={onSelect}
            onActivate={onActivate}
          />
        ) : (
          <div class="empty">
            <Icon name="map" size={28} />
            <h2>{t("map.emptyTitle")}</h2>
            <p>{state.map.focus ? t("map.emptyFocus") : t(`map.empty.${state.map.level}`)}</p>
          </div>
        )}
        {!showList && !bizEmpty ? <Legend scene={scene} /> : null}
      </div>

      <nav class="crumbs" aria-label={t("map.breadcrumb")}>
        <ol>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            const label = c.part !== undefined ? t("map.part", { n: c.part + 1 }) : c.id ? c.label : t(`level.${c.level}`);
            return (
              <li key={c.id ?? c.label}>
                {last ? (
                  <span aria-current="page">{label}</span>
                ) : (
                  <button type="button" class="link" onClick={() => update({ map: c.state, spotlight: undefined }, "push")}>
                    {label}
                  </button>
                )}
                {!last ? <Icon name="chevronRight" size={12} /> : null}
              </li>
            );
          })}
        </ol>
        {state.map.focus ? <span class="crumb-hint">{t("map.crumbHint")}</span> : <span class="crumb-hint">{t("map.drillHint")}</span>}
      </nav>
    </div>
  );
}
