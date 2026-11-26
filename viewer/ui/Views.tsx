// The non-map views: Data (ERD), Flows (stepper), Lenses (saved questions),
// Changes (change views and the timeline) and Insights.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import { type ChangeView, normalizeChanges, OVERLAY_KINDS, type OverlayKind, timelineViews } from "../lib/changes.js";
import { num, t } from "../lib/i18n.js";
import { erdScene, type SceneNode, subgraphScene } from "../lib/levels.js";
import { stripCites } from "../lib/markdown.js";
import { insightContext, stepContext } from "../lib/chat.js";
import { askAboutInsight, reaskLens, retraceFlow } from "../lib/prompts.js";
import { useApp } from "./context.js";
import { kindName } from "./format.js";
import { Graph } from "./Graph.js";
import { Icon } from "./icons.js";
import { Legend } from "./MapView.js";
import { CopyButton, Markdown, Prose } from "./Prose.js";
import { SceneList } from "./SceneList.js";

function Empty({ icon, title, children }: { icon: string; title: string; children: ComponentChildren }): JSX.Element {
  return (
    <div class="empty">
      <Icon name={icon} size={28} />
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function Cmd({ children }: { children: string }): JSX.Element {
  return <code class="cmd">{children}</code>;
}

function Rail({ label, children }: { label: string; children: ComponentChildren }): JSX.Element {
  return (
    <nav class="rail" aria-label={label}>
      <ul>{children}</ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Data

export function DataModelsView(): JSX.Element {
  const { ix, version, state, select, narrow } = useApp();
  const scene = useMemo(() => erdScene(ix), [ix, version]);
  if (!scene.nodes.length) {
    return (
      <Empty icon="data" title={t("data.emptyTitle")}>
        <p>{t("data.emptyBody")}</p>
        <p>
          <Cmd>ultraview build</Cmd>
        </p>
      </Empty>
    );
  }
  const onSelect = (n: SceneNode | undefined) => select(n?.ref);
  return (
    <div class="map">
      <div class="map-tools">
        <p class="tools-note">{t("data.intro", { count: scene.nodes.length })}</p>
      </div>
      <div class="map-canvas">
        {state.listMode || narrow ? (
          <SceneList scene={scene} selected={state.selected} onSelect={onSelect} onActivate={onSelect} />
        ) : (
          <Graph scene={scene} variant="erd" label={t("data.aria")} selected={state.selected} onSelect={onSelect} onActivate={onSelect} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flows

export function FlowsView(): JSX.Element {
  const { ix, version, state, update, reveal, narrow, chat } = useApp();
  const flows = ix.view.flows ?? [];
  const flow = flows.find((f) => f.id === state.flow) ?? (flows.length === 1 ? flows[0] : undefined);
  const step = flow ? Math.max(0, Math.min(state.step, flow.steps.length - 1)) : 0;
  const scene = useMemo(() => {
    if (!flow) return undefined;
    const ids = flow.steps.map((s) => s.node);
    const extra = ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id, kind: "step" as const }));
    return subgraphScene(ix, `flow:${flow.id}`, ids, extra);
  }, [flow, ix, version]);
  const badges = useMemo(() => {
    const m = new Map<string, string>();
    flow?.steps.forEach((s, i) => {
      if (!m.has(s.node)) m.set(s.node, String(i + 1));
    });
    return m;
  }, [flow]);

  // A single flow opens by itself, on its first step.
  useEffect(() => {
    if (!state.flow && flow) update({ flow: flow.id, step: 0, selected: flow.steps[0]?.node }, "replace");
  }, [state.flow, flow?.id]);
  const go = (i: number) => {
    if (!flow) return;
    const next = Math.max(0, Math.min(flow.steps.length - 1, i));
    update({ flow: flow.id, step: next, selected: flow.steps[next]?.node }, "replace");
  };
  useEffect(() => {
    if (!flow) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element)?.closest?.(".graph-svg [role=button]")) return;
      if (e.key === "ArrowRight") go(step + 1);
      else if (e.key === "ArrowLeft") go(step - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow?.id, step]);

  if (!flows.length) {
    return (
      <Empty icon="flow" title={t("flows.emptyTitle")}>
        <p>{t("flows.emptyBody")}</p>
        <p>
          <Cmd>ultraview flow save &lt;file&gt;</Cmd>
        </p>
      </Empty>
    );
  }
  const cur = flow?.steps[step];
  const curNode = cur ? ix.byId.get(cur.node) : undefined;
  const stale = flow ? ix.staleFlows.has(flow.id) : false;
  return (
    <div class="split">
      <Rail label={t("flows.list")}>
        {flows.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              class={`rail-item${f.id === flow?.id ? " on" : ""}${ix.staleFlows.has(f.id) ? " stale" : ""}`}
              aria-current={f.id === flow?.id ? "true" : undefined}
              onClick={() => update({ flow: f.id, step: 0, selected: f.steps[0]?.node }, "push")}
            >
              <span class="rail-title">{f.title}</span>
              <span class="rail-meta">
                {t("flows.steps", { count: f.steps.length })}
                {ix.staleFlows.has(f.id) ? <span class="tag tag-warn">{t("stale.badge")}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </Rail>
      {flow && scene && cur ? (
        <div class="split-main">
          <section class="stepper" aria-labelledby="flow-title" aria-live="polite">
            <div class="stepper-head">
              <h2 id="flow-title">{flow.title}</h2>
              {stale ? (
                <span class="stale-note">
                  <Icon name="warning" size={14} />
                  {t("stale.flow")}
                  <CopyButton text={retraceFlow(flow.id, flow.title)} label={t("stale.retrace")} message={t("toast.promptCopied")} icon="refresh" />
                </span>
              ) : null}
            </div>
            <ol class="steps" aria-label={t("flows.stepsAria")}>
              {flow.steps.map((s, i) => (
                <li key={`${s.node}-${i}`}>
                  <button
                    type="button"
                    class={`step-dot${i === step ? " on" : ""}${i < step ? " done" : ""}`}
                    aria-label={t("flows.goStep", { n: i + 1, label: ix.byId.get(s.node)?.label ?? s.node })}
                    aria-current={i === step ? "step" : undefined}
                    onClick={() => go(i)}
                  >
                    {i + 1}
                  </button>
                </li>
              ))}
            </ol>
            <div class="step-card">
              <div class="step-label">
                {t("flows.stepOf", { n: step + 1, total: flow.steps.length })}
                {curNode ? (
                  <>
                    {" · "}
                    <button type="button" class="link" onClick={() => update({ selected: cur.node, panelOpen: true })}>
                      {curNode.label}
                    </button>
                    <span class="muted"> ({kindName(curNode.kind)})</span>
                  </>
                ) : null}
              </div>
              <Prose text={cur.note} />
              <div class="step-actions">
                <button type="button" class="btn" disabled={step === 0} onClick={() => go(step - 1)}>
                  <Icon name="chevronLeft" size={14} />
                  {t("flows.prev")}
                </button>
                <button type="button" class="btn btn-primary" disabled={step === flow.steps.length - 1} onClick={() => go(step + 1)}>
                  {t("flows.next")}
                  <Icon name="chevronRight" size={14} />
                </button>
                <button
                  type="button"
                  class="btn btn-quiet"
                  onClick={() => reveal(cur.node, { ids: flow.steps.map((s) => s.node), label: t("spot.flow", { title: flow.title }) })}
                >
                  <Icon name="map" size={14} />
                  {t("flows.showOnMap")}
                </button>
                <button type="button" class="btn btn-quiet" onClick={() => chat.open({ context: stepContext(flow.id, step) })}>
                  <Icon name="ask" size={14} />
                  {t("flows.ask")}
                </button>
                <span class="kbd-hint">{t("flows.keys")}</span>
              </div>
            </div>
          </section>
          <div class="map-canvas sub">
            {state.listMode || narrow ? (
              <SceneList scene={scene} selected={cur.node} onSelect={(n) => update({ selected: n.ref, panelOpen: true })} onActivate={(n) => reveal(n.ref)} />
            ) : (
              <Graph
                scene={scene}
                label={t("flows.aria", { title: flow.title })}
                selected={cur.node}
                badges={badges}
                spotlight={new Set([cur.node])}
                center={{ id: cur.node, nonce: step }}
                onSelect={(n) => {
                  if (!n) return;
                  const i = flow.steps.findIndex((s) => s.node === n.ref);
                  if (i !== -1) go(i);
                  update({ selected: n.ref, panelOpen: true });
                }}
                onActivate={(n) => reveal(n.ref)}
              />
            )}
            <Legend scene={scene} />
          </div>
        </div>
      ) : (
        <Empty icon="flow" title={t("flows.pick")}>
          <p>{t("flows.pickBody")}</p>
        </Empty>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lenses

export function LensesView(): JSX.Element {
  const { ix, version, state, update, reveal, narrow, chat } = useApp();
  const asking = chat.can === "ready" || chat.can === "busy";
  const askHead = asking ? (
    <header class="view-head">
      <button type="button" class="btn btn-primary" onClick={() => chat.open()}>
        <Icon name="ask" size={14} />
        {t("lenses.ask")}
      </button>
    </header>
  ) : null;
  const lenses = ix.view.lenses ?? [];
  const lens = lenses.find((l) => l.id === state.lens) ?? (lenses.length === 1 ? lenses[0] : undefined);
  useEffect(() => {
    if (!state.lens && lens) update({ lens: lens.id, selected: lens.focus ?? lens.nodes[0] }, "replace");
  }, [state.lens, lens?.id]);
  const scene = useMemo(() => {
    if (!lens) return undefined;
    const ids = [...lens.nodes];
    if (lens.focus && !ids.includes(lens.focus)) ids.unshift(lens.focus);
    return subgraphScene(
      ix,
      `lens:${lens.id}`,
      ids,
      (lens.edges ?? []).map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    );
  }, [lens, ix, version]);
  if (!lenses.length) {
    return (
      <div class="lenses">
        {askHead}
        <Empty icon="lens" title={t("lenses.emptyTitle")}>
          <p>{asking ? t("lenses.emptyAsk") : t("lenses.emptyBody")}</p>
          {asking ? null : (
            <p>
              <Cmd>ultraview lens save &lt;file&gt;</Cmd>
            </p>
          )}
        </Empty>
      </div>
    );
  }
  const stale = lens ? ix.staleLenses.has(lens.id) : false;
  const focus = lens?.focus ?? lens?.nodes[0];
  return (
    <div class="lenses">
      {askHead}
      <div class="split">
        <Rail label={t("lenses.list")}>
          {lenses.map((l) => {
            const isStale = ix.staleLenses.has(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  class={`rail-item${l.id === lens?.id ? " on" : ""}${isStale ? " stale" : ""}`}
                  aria-current={l.id === lens?.id ? "true" : undefined}
                  onClick={() => update({ lens: l.id, selected: l.focus ?? l.nodes[0] }, "push")}
                >
                  <span class="rail-title">{l.question}</span>
                  <span class="rail-meta">
                    {t("lenses.nodes", { count: l.nodes.length })}
                    {isStale ? <span class="tag tag-warn">{t("stale.badge")}</span> : null}
                  </span>
                </button>
                {isStale ? (
                  <div class="rail-extra">
                    <CopyButton text={reaskLens(l.id, l.question)} label={t("stale.reask")} message={t("toast.promptCopied")} icon="refresh" />
                  </div>
                ) : null}
              </li>
            );
          })}
        </Rail>
        {lens && scene ? (
          <div class="split-main">
            <article class={`answer${stale ? " stale" : ""}`} aria-labelledby="lens-q">
              <h2 id="lens-q">{lens.question}</h2>
              {stale ? (
                <p class="stale-note">
                  <Icon name="warning" size={14} />
                  {t("stale.lens")}
                  <CopyButton text={reaskLens(lens.id, lens.question)} label={t("stale.reask")} message={t("toast.promptCopied")} icon="refresh" />
                </p>
              ) : null}
              <Markdown text={lens.answer} />
              {focus ? (
                <button type="button" class="btn btn-quiet" onClick={() => reveal(focus, { ids: lens.nodes, label: t("spot.lens", { q: lens.question }) })}>
                  <Icon name="map" size={14} />
                  {t("lenses.showOnMap")}
                </button>
              ) : null}
            </article>
            <div class="map-canvas sub">
              {state.listMode || narrow ? (
                <SceneList
                  scene={scene}
                  selected={state.selected}
                  onSelect={(n) => update({ selected: n.ref, panelOpen: true })}
                  onActivate={(n) => reveal(n.ref)}
                />
              ) : (
                <Graph
                  scene={scene}
                  label={t("lenses.aria", { q: lens.question })}
                  selected={state.selected ?? focus}
                  center={focus ? { id: focus, nonce: 0 } : undefined}
                  onSelect={(n) => update({ selected: n?.ref, panelOpen: !!n })}
                  onActivate={(n) => reveal(n.ref)}
                />
              )}
              <Legend scene={scene} />
            </div>
          </div>
        ) : (
          <Empty icon="lens" title={t("lenses.pick")}>
            <p>{t("lenses.pickBody")}</p>
          </Empty>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function ChangesView(): JSX.Element {
  const { ix, version, state, update, narrow } = useApp();
  const recorded = useMemo(() => normalizeChanges(ix.view.changes), [ix]);
  const timeline = useMemo(() => timelineViews(ix.view.timeline), [ix]);
  const all: ChangeView[] = [...recorded, ...timeline];
  const cur = all.find((c) => c.id === state.change) ?? all[0];
  const scene = useMemo(
    () =>
      cur
        ? subgraphScene(
            ix,
            `change:${cur.id}`,
            cur.items.map((i) => i.ref),
          )
        : undefined,
    [cur, ix, version],
  );
  const overlay = useMemo(() => new Map<string, OverlayKind>((cur?.items ?? []).map((i) => [i.ref, i.change])), [cur]);
  if (!all.length) {
    return (
      <Empty icon="changes" title={t("changes.emptyTitle")}>
        <p>{t("changes.emptyBody")}</p>
        <p>
          <Cmd>ultraview diff --record</Cmd>
        </p>
        <p class="muted small">{t("changes.emptyHook")}</p>
      </Empty>
    );
  }
  const groups = OVERLAY_KINDS.map((k) => ({ k, items: (cur?.items ?? []).filter((i) => i.change === k) })).filter((g) => g.items.length);
  return (
    <div class="split">
      <Rail label={t("changes.list")}>
        {recorded.length ? <li class="rail-group">{t("changes.recorded")}</li> : null}
        {recorded.map((c) => (
          <ChangeItem key={c.id} c={c} on={c.id === cur?.id} />
        ))}
        {timeline.length ? <li class="rail-group">{t("changes.timeline")}</li> : null}
        {timeline.map((c) => (
          <ChangeItem key={c.id} c={c} on={c.id === cur?.id} />
        ))}
      </Rail>
      {cur ? (
        <div class="split-main">
          <article class="answer" aria-labelledby="change-title">
            <h2 id="change-title">{cur.title}</h2>
            <p class="muted small">
              {[
                cur.origin ? t(`source.${cur.origin}`) : t("changes.recordedOne"),
                cur.at ? new Date(cur.at).toLocaleString() : "",
                cur.base && cur.head ? `${cur.base.slice(0, 8)}…${cur.head.slice(0, 8)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {cur.request ? (
              <p class="request">
                <span class="muted">{t("changes.request")}</span> {cur.request}
              </p>
            ) : null}
            {cur.summary ? <Prose text={cur.summary} /> : null}
            {groups.map((g) => (
              <section key={g.k} class="panel-sec">
                <h3>
                  <span class={`ov-key ov-${g.k}`}>{t(`change.${g.k}`)}</span>
                  <span class="count">{num(g.items.length)}</span>
                </h3>
                <ul class="node-list">
                  {[...g.items]
                    .sort((a, b) => (RISK_ORDER[a.risk ?? "low"] ?? 3) - (RISK_ORDER[b.risk ?? "low"] ?? 3))
                    .map((it) => (
                      <li key={it.ref}>
                        <button type="button" class="node-link" onClick={() => update({ selected: it.ref, panelOpen: true })}>
                          <Icon name={ix.byId.get(it.ref)?.kind ?? "dot"} size={14} />
                          <span class="node-link-label">{ix.byId.get(it.ref)?.label ?? it.ref}</span>
                          {it.risk ? <span class={`tag risk-${it.risk}`}>{t(`risk.${it.risk}`)}</span> : null}
                        </button>
                        {it.note ? <Prose text={it.note} class="small muted" /> : null}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
            {cur.items.length ? (
              <button type="button" class="btn btn-quiet" onClick={() => update({ view: "map", overlay: cur.id }, "push")}>
                <Icon name="map" size={14} />
                {t("changes.overlay")}
              </button>
            ) : null}
          </article>
          {scene?.nodes.length ? (
            <div class="map-canvas sub">
              {state.listMode || narrow ? (
                <SceneList
                  scene={scene}
                  selected={state.selected}
                  onSelect={(n) => update({ selected: n.ref, panelOpen: true })}
                  onActivate={(n) => update({ selected: n.ref })}
                />
              ) : (
                <Graph
                  scene={scene}
                  label={t("changes.aria", { title: cur.title })}
                  selected={state.selected}
                  overlay={overlay}
                  onSelect={(n) => update({ selected: n?.ref, panelOpen: !!n })}
                />
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChangeItem({ c, on }: { c: ChangeView; on: boolean }): JSX.Element {
  const { update } = useApp();
  return (
    <li>
      <button type="button" class={`rail-item${on ? " on" : ""}`} aria-current={on ? "true" : undefined} onClick={() => update({ change: c.id }, "push")}>
        <span class="rail-title">{c.title}</span>
        <span class="rail-meta">
          {c.at ? new Date(c.at).toLocaleDateString() : ""}
          {c.items.length ? ` · ${t("changes.items", { count: c.items.length })}` : ""}
        </span>
        {c.summary ? <span class="rail-sum">{stripCites(c.summary)}</span> : null}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Insights

export function InsightsView(): JSX.Element {
  const { ix, insights, reveal, chat } = useApp();
  if (!insights.length) {
    return (
      <Empty icon="insights" title={t("insights.emptyTitle")}>
        <p>{t("insights.emptyBody")}</p>
        <p>
          <Cmd>ultraview insights</Cmd>
        </p>
      </Empty>
    );
  }
  return (
    <div class="insights">
      <h2 class="view-title">{t("insights.title", { count: insights.length })}</h2>
      <ul class="insight-list">
        {insights.map((i) => (
          <li key={i.id} class={`insight sev-${i.severity}`}>
            <div class="insight-head">
              <span class={`tag sev sev-${i.severity}`}>{t(`severity.${i.severity}`)}</span>
              {i.kind ? <span class="muted small">{i.kind}</span> : null}
            </div>
            <h3>{i.title}</h3>
            {i.summary ? <Prose text={i.summary} /> : null}
            {i.nodes.length ? (
              <div class="chips">
                {i.nodes.slice(0, 12).map((id) => (
                  <button key={id} type="button" class="cap-chip" onClick={() => reveal(id, { ids: i.nodes, label: i.title })}>
                    <Icon name={ix.byId.get(id)?.kind ?? "dot"} size={12} />
                    {ix.byId.get(id)?.label ?? id}
                  </button>
                ))}
              </div>
            ) : null}
            <div class="insight-actions">
              <button type="button" class="btn btn-primary" onClick={() => chat.open({ context: insightContext(i.id) })}>
                <Icon name="ask" size={14} />
                {t("insights.ask")}
              </button>
              <CopyButton text={i.prompt ?? askAboutInsight(i.title, i.nodes)} label={t("insights.copyPrompt")} message={t("toast.promptCopied")} icon="ask" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
