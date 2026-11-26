// The text alternative to the drawing: the current level as an accessible
// table (name, kind, where, links, capabilities), virtualized so a level of
// thousands of rows stays fast. Also the phone layout under 600 px.

import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { pathOf } from "../lib/data.js";
import { num, t } from "../lib/i18n.js";
import type { Scene, SceneNode } from "../lib/levels.js";
import { useApp } from "./context.js";
import { capVar, kindName, subline } from "./format.js";
import { Icon } from "./icons.js";

const ROW = 44;
const OVERSCAN = 8;

export function useVirtual(count: number, row: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / row) - OVERSCAN);
      const end = Math.min(count, Math.ceil((el.scrollTop + el.clientHeight) / row) + OVERSCAN);
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(update) : undefined;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [count, row]);
  return { ref, ...range };
}

export function SceneList({
  scene,
  selected,
  onSelect,
  onActivate,
}: {
  scene: Scene;
  selected?: string;
  onSelect: (n: SceneNode) => void;
  onActivate: (n: SceneNode) => void;
}): JSX.Element {
  const { ix, state } = useApp();
  const rows = useMemo(() => {
    const parents = new Map(scene.nodes.map((n) => [n.id, n]));
    const depth = (n: SceneNode) => {
      let d = 0;
      let cur = n.parent ? parents.get(n.parent) : undefined;
      while (cur && d < 6) {
        d++;
        cur = cur.parent ? parents.get(cur.parent) : undefined;
      }
      return d;
    };
    // Groups first, each followed by what it holds (document order of the tree).
    const kids = new Map<string, SceneNode[]>();
    const top: SceneNode[] = [];
    for (const n of scene.nodes) {
      if (n.parent && parents.has(n.parent)) {
        const l = kids.get(n.parent) ?? [];
        l.push(n);
        kids.set(n.parent, l);
      } else top.push(n);
    }
    const out: { n: SceneNode; depth: number }[] = [];
    const visit = (n: SceneNode) => {
      out.push({ n, depth: depth(n) });
      for (const k of kids.get(n.id) ?? []) visit(k);
    };
    for (const n of top) visit(n);
    return out;
  }, [scene]);
  const links = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of scene.edges) {
      m.set(e.from, (m.get(e.from) ?? 0) + 1);
      m.set(e.to, (m.get(e.to) ?? 0) + 1);
    }
    return m;
  }, [scene]);
  const v = useVirtual(rows.length, ROW);
  const [active, setActive] = useState(0);
  const dev = state.audience === "developer";

  const focusRow = (i: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, i));
    setActive(clamped);
    const el = v.ref.current;
    if (el) {
      const top = clamped * ROW;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW > el.scrollTop + el.clientHeight - ROW) el.scrollTop = top - el.clientHeight + ROW * 2;
    }
    requestAnimationFrame(() => el?.querySelector<HTMLElement>(`[data-row="${clamped}"]`)?.focus());
  };
  const onKey = (i: number, n: SceneNode, e: KeyboardEvent) => {
    if (e.key === "ArrowDown") focusRow(i + 1);
    else if (e.key === "ArrowUp") focusRow(i - 1);
    else if (e.key === "Home") focusRow(0);
    else if (e.key === "End") focusRow(rows.length - 1);
    else if (e.key === "Enter") onActivate(n);
    else if (e.key === " ") onSelect(n);
    else return;
    e.preventDefault();
  };

  if (!rows.length) return <div class="empty">{t("map.emptyTitle")}</div>;
  return (
    <div class="scene-list" role="table" aria-label={t("list.aria", { level: t(`level.${state.map.level}`) })} aria-rowcount={rows.length + 1}>
      <div class="sl-head" role="rowgroup">
        <div class="sl-row" role="row" aria-rowindex={1} tabIndex={-1}>
          <span role="columnheader" tabIndex={-1}>
            {t("list.name")}
          </span>
          <span role="columnheader" tabIndex={-1}>
            {t("list.kind")}
          </span>
          <span role="columnheader" tabIndex={-1} class="sl-wide">
            {dev ? t("list.where") : t("list.about")}
          </span>
          <span role="columnheader" tabIndex={-1} class="sl-num">
            {t("list.links")}
          </span>
        </div>
      </div>
      <div class="sl-body" role="rowgroup" ref={v.ref}>
        <div style={{ height: `${rows.length * ROW}px`, position: "relative" }}>
          {rows.slice(v.start, v.end).map(({ n, depth }, j) => {
            const i = v.start + j;
            const node = ix.byId.get(n.ref);
            const where =
              n.role === "cluster"
                ? t("graph.clusterCount", { count: n.count ?? 0 })
                : node
                  ? dev
                    ? (pathOf(node) ?? subline(ix, node, state.audience))
                    : subline(ix, node, state.audience)
                  : "";
            return (
              <div
                key={n.id}
                class={`sl-row${selected === n.id ? " sel" : ""}${n.role === "ghost" ? " ghost" : ""}`}
                role="row"
                aria-rowindex={i + 2}
                aria-selected={selected === n.id}
                data-row={i}
                tabIndex={i === active ? 0 : -1}
                style={{ position: "absolute", top: `${i * ROW}px`, left: 0, right: 0, height: `${ROW}px` }}
                onClick={() => {
                  setActive(i);
                  onSelect(n);
                }}
                onDblClick={() => onActivate(n)}
                onKeyDown={(e) => onKey(i, n, e)}
              >
                <span role="cell" class="sl-name" style={{ paddingLeft: `${12 + depth * 18}px` }}>
                  <span
                    class="kind-dot"
                    style={{ background: node?.caps[0] ? capVar(ix, node.caps[0]) : n.kind === "cap" ? capVar(ix, n.ref) : "var(--cap-none)" }}
                    aria-hidden="true"
                  />
                  <Icon name={n.role === "cluster" ? "cluster" : n.kind} size={14} />
                  <span class="sl-label">{n.label}</span>
                  {n.role === "ghost" ? <span class="tag">{t("list.outside")}</span> : null}
                </span>
                <span role="cell" class="muted">
                  {kindName(n.kind)}
                </span>
                <span role="cell" class="muted sl-wide">
                  {where}
                </span>
                <span role="cell" class="sl-num">
                  {num(links.get(n.id) ?? 0)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
