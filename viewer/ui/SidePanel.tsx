// The selected node, explained: what it is, where it sits, what it serves,
// what it holds, what it uses and what uses it — every claim with its chip.

import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { ancestors, type AnyKind, type Index, locationOf, pathOf, type XEdge, type XNode } from "../lib/data.js";
import { num, t } from "../lib/i18n.js";
import { nodeLabels } from "../lib/labels.js";
import { drillTarget } from "../lib/nav.js";
import { askAboutNode } from "../lib/prompts.js";
import { useApp } from "./context.js";
import { capVar, kindName } from "./format.js";
import { Icon } from "./icons.js";
import { CiteChip, LocationChip, Prose } from "./Prose.js";

const LIST_CAP = 40;

function NodeLink({ id, note, label }: { id: string; note?: string; label?: string }): JSX.Element {
  const { ix, select } = useApp();
  const n = ix.byId.get(id);
  return (
    <button type="button" class="node-link" onClick={() => select(id)}>
      <Icon name={n?.kind ?? "dot"} size={14} />
      <span class="node-link-label">{label ?? n?.label ?? id}</span>
      {note ? <span class="node-link-note">{note}</span> : null}
    </button>
  );
}

function NodeList({ ids, notes }: { ids: string[]; notes?: Map<string, string> }): JSX.Element {
  const { ix } = useApp();
  const shown = ids.slice(0, LIST_CAP);
  const labels = nodeLabels(ix, shown);
  return (
    <ul class="node-list">
      {shown.map((id) => (
        <li key={id}>
          <NodeLink id={id} note={notes?.get(id)} label={labels.get(id)} />
        </li>
      ))}
      {ids.length > LIST_CAP ? <li class="muted small">{t("panel.andMore", { count: ids.length - LIST_CAP })}</li> : null}
    </ul>
  );
}

function Section({ title, children, count }: { title: string; count?: number; children: JSX.Element | (JSX.Element | null)[] | null }): JSX.Element {
  return (
    <section class="panel-sec">
      <h3>
        {title}
        {count !== undefined ? <span class="count">{num(count)}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** Everything below a node by kind (structure) — or its members, for a capability. */
function membersByKind(ix: Index, n: XNode): Map<AnyKind, string[]> {
  const out = new Map<AnyKind, string[]>();
  const ids = n.kind === "cap" ? (ix.capMembers.get(n.id) ?? []) : (ix.children.get(n.id) ?? []);
  for (const id of ids) {
    const m = ix.byId.get(id);
    if (!m) continue;
    const list = out.get(m.kind) ?? [];
    list.push(id);
    out.set(m.kind, list);
  }
  for (const list of out.values()) list.sort((a, b) => (ix.byId.get(a)!.label < ix.byId.get(b)!.label ? -1 : 1));
  return out;
}

function groupEdges(edges: readonly XEdge[], side: "out" | "in"): Map<string, { id: string; weight: number; label?: string }[]> {
  const out = new Map<string, { id: string; weight: number; label?: string }[]>();
  for (const e of edges) {
    const list = out.get(e.kind) ?? [];
    list.push({ id: side === "out" ? e.to : e.from, weight: e.weight, ...(e.label ? { label: e.label } : {}) });
    out.set(e.kind, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
  return out;
}

function Edges({ title, edges, side }: { title: string; edges: readonly XEdge[]; side: "out" | "in" }): JSX.Element | null {
  if (!edges.length) return null;
  const groups = groupEdges(edges, side);
  return (
    <Section title={title} count={new Set(edges.map((e) => (side === "out" ? e.to : e.from))).size}>
      {[...groups.entries()].map(([kind, list]) => (
        <div key={kind} class="edge-group">
          <div class={`edge-kind k-${kind}`}>
            <span class="swatch" aria-hidden="true" />
            {t(`edge.${kind}`)}
          </div>
          <NodeList
            ids={list.map((x) => x.id)}
            notes={new Map(list.map((x) => [x.id, [x.label, x.weight > 1 ? `×${x.weight}` : ""].filter(Boolean).join(" ")]))}
          />
        </div>
      ))}
    </Section>
  );
}

export function SidePanel(): JSX.Element | null {
  const api = useApp();
  const { ix, state, update, copy, reveal, drill } = api;
  const n = state.selected ? ix.byId.get(state.selected) : undefined;
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (n && state.panelOpen) head.current?.focus({ preventScroll: true });
  }, [n?.id]);
  if (!state.panelOpen || !n) return null;

  const dev = state.audience === "developer";
  const trail = ancestors(ix, n.id).reverse();
  const members = membersByKind(ix, n);
  const outE = (ix.out.get(n.id) ?? []).filter((e) => e.kind !== "contains");
  const inE = (ix.in.get(n.id) ?? []).filter((e) => e.kind !== "contains");
  const loc = locationOf(n);
  const path = pathOf(n);
  const counts = ix.counts.get(n.id);
  const canDrill = !!drillTarget(ix, n.id) && (dev || (n.kind !== "mod" && n.kind !== "file"));
  const onMap = state.view === "map";

  // Entities: who reads and writes them (data edges in).
  const users = n.kind === "entity" ? inE.filter((e) => e.kind === "data" && e.from.startsWith("file:")) : [];
  const metrics: [string, number][] = [];
  if (n.metrics.loc) metrics.push([t("metric.loc"), n.metrics.loc]);
  if (n.metrics.tests) metrics.push([t("metric.tests"), n.metrics.tests]);
  if (n.metrics.churn) metrics.push([t("metric.churn"), n.metrics.churn]);
  if (counts?.mod && n.kind !== "mod") metrics.push([t("metric.modules"), counts.mod]);
  if (counts?.file && n.kind !== "file") metrics.push([t("metric.files"), counts.file]);
  if (counts?.route) metrics.push([t("metric.routes"), counts.route]);
  if (counts?.entity && n.kind !== "entity") metrics.push([t("metric.entities"), counts.entity]);

  const memberOrder: AnyKind[] = ["sys", "mod", "file", "route", "screen", "job", "entity", "sym", "ext", "infra"];

  return (
    <aside class="panel" aria-labelledby="panel-title">
      <header class="panel-head">
        <div class="panel-kind">
          <span
            class="kind-dot"
            style={{ background: n.kind === "cap" ? capVar(ix, n.id) : n.caps[0] ? capVar(ix, n.caps[0]) : "var(--cap-none)" }}
            aria-hidden="true"
          />
          <Icon name={n.kind} size={14} />
          {kindName(n.kind)}
        </div>
        <h2 id="panel-title" tabIndex={-1} ref={head}>
          {n.label}
        </h2>
        <button type="button" class="icon-btn panel-close" aria-label={t("panel.close")} title={t("panel.close")} onClick={() => update({ panelOpen: false })}>
          <Icon name="close" />
        </button>
        {trail.length ? (
          <nav class="trail" aria-label={t("panel.trail")}>
            {trail.map((a) => (
              <button key={a.id} type="button" class="trail-item" onClick={() => api.select(a.id)}>
                {a.label}
              </button>
            ))}
          </nav>
        ) : null}
        {dev && path ? (
          <div class="panel-path">
            <code>{n.id}</code>
          </div>
        ) : null}
      </header>

      <div class="panel-actions">
        {!onMap || state.listMode ? (
          <button type="button" class="btn" onClick={() => reveal(n.id)}>
            <Icon name="map" size={14} />
            {t("panel.showOnMap")}
          </button>
        ) : null}
        {canDrill && onMap ? (
          <button type="button" class="btn" onClick={() => drill(n.id)}>
            <Icon name="drill" size={14} />
            {t("panel.drill")}
          </button>
        ) : null}
        <button type="button" class="btn btn-primary" onClick={() => copy(askAboutNode(n.id, n.label), t("toast.promptCopied"))}>
          <Icon name="ask" size={14} />
          {t("panel.ask")}
        </button>
        {loc ? <CiteChip cite={{ path: loc.path, line: loc.line, raw: "" }} full={dev} /> : null}
      </div>

      <div class="panel-body">
        {n.summary ? (
          <Prose text={n.summary} class="panel-summary" />
        ) : (
          <p class="muted panel-summary">{n.kind === "actor" ? t("panel.actorSummary", { label: n.label }) : t("panel.noSummary")}</p>
        )}

        {n.caps.length ? (
          <Section title={t("panel.capabilities")}>
            <div class="chips">
              {n.caps.map((c) => (
                <button key={c} type="button" class="cap-chip" onClick={() => api.select(c)}>
                  <span class="kind-dot" style={{ background: capVar(ix, c) }} aria-hidden="true" />
                  {ix.byId.get(c)?.label ?? c}
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        {n.actors?.length ? (
          <Section title={t("panel.actors")}>
            <div class="chips">
              {n.actors.map((a) => (
                <button key={a} type="button" class="cap-chip" onClick={() => api.select(`actor:${a}`)}>
                  <Icon name="actor" size={12} />
                  {a}
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        {metrics.length ? (
          <Section title={t("panel.metrics")}>
            <dl class="metrics">
              {metrics.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{num(v)}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}

        {n.fields?.length ? (
          <Section title={t("panel.fields")} count={n.fields.length}>
            <table class="fields">
              <tbody>
                {n.fields.map((f) => (
                  <tr key={f.name}>
                    <th scope="row">{f.name}</th>
                    <td>
                      {f.relation ? (
                        <button type="button" class="link" onClick={() => api.select(`entity:${f.relation}`)}>
                          {f.type}
                        </button>
                      ) : (
                        f.type
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        ) : null}

        {users.length ? (
          <Section title={t("panel.usedBy")} count={users.length}>
            <NodeList ids={users.map((e) => e.from)} notes={new Map(users.map((e) => [e.from, e.label ? t(`op.${e.label}`) : ""]))} />
            <button
              type="button"
              class="btn btn-quiet"
              onClick={() => reveal(users[0]!.from, { ids: [n.id, ...users.map((e) => e.from)], label: t("spot.entityUsers", { label: n.label }) })}
            >
              <Icon name="map" size={14} />
              {t("panel.showUsers")}
            </button>
          </Section>
        ) : null}

        {n.kind === "actor"
          ? (() => {
              const caps = outE.filter((e) => e.kind === "uses").map((e) => e.to);
              return caps.length ? (
                <Section title={t("panel.actorUses")} count={caps.length}>
                  <NodeList ids={caps} />
                </Section>
              ) : null;
            })()
          : null}

        {memberOrder
          .filter((k) => members.get(k)?.length && (dev || (k !== "file" && k !== "sym")))
          .map((k) => (
            <Section key={k} title={t(`panel.members.${k}`)} count={members.get(k)!.length}>
              <NodeList ids={members.get(k)!} />
            </Section>
          ))}

        {n.kind !== "actor" ? <Edges title={t("panel.uses")} edges={outE} side="out" /> : null}
        <Edges title={t("panel.usedByEdges")} edges={inE.filter((e) => !(n.kind === "entity" && e.kind === "data" && e.from.startsWith("file:")))} side="in" />

        {n.cites.length ? (
          <Section title={t("panel.sources")} count={n.cites.length}>
            <div class="chips">
              {n.cites.map((c) => (
                <LocationChip key={c} at={c} full />
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </aside>
  );
}
