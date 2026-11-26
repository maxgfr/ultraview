// The SVG map: lays a scene out (ELK, cached), draws groups, edges and cards,
// and handles pan / zoom (wheel, drag, pinch, keyboard), hover neighbourhoods
// and roving keyboard focus between nodes. The camera lives in a ref and is
// applied straight to the DOM, so panning never re-renders the cards.

import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { OverlayKind } from "../lib/changes.js";
import type { Box, Layout, Pt } from "../lib/elk.js";
import { t } from "../lib/i18n.js";
import { ERD_HEAD, ERD_MAX_FIELDS, ERD_ROW, type Scene, type SceneEdge, type SceneNode } from "../lib/levels.js";
import { useApp } from "./context.js";
import { capVar, describeNode, ellipsize, fitParts, groupParts, kindName, sceneLabel, sublineParts } from "./format.js";
import { Glyph, Icon } from "./icons.js";
import { cachedLayout, layoutScene, releaseLayout } from "./layout.js";
import { perfPainted, perfStep } from "./perf.js";

export interface GraphProps {
  scene: Scene;
  label: string;
  /** Selected scene id. */
  selected?: string;
  spotlight?: ReadonlySet<string>;
  overlay?: ReadonlyMap<string, OverlayKind>;
  /** Small text badges on cards (flow step numbers). */
  badges?: ReadonlyMap<string, string>;
  center?: { id: string; nonce: number };
  variant?: "map" | "erd";
  onSelect: (n: SceneNode | undefined) => void;
  onActivate?: (n: SceneNode) => void;
}

interface Cam {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.12;
const MAX_K = 2.5;
/** Fit to screen zooms a small graph in, up to this. */
const FIT_MAX_K = 1.5;
const cameras = new Map<string, Cam>();
let graphSeq = 0;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A polyline with rounded corners. */
function roundedPath(pts: readonly Pt[], r = 8): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr < 0.5) {
      d += `L${p1.x},${p1.y}`;
      continue;
    }
    const a = { x: p1.x + ((p0.x - p1.x) * rr) / d1, y: p1.y + ((p0.y - p1.y) * rr) / d1 };
    const b = { x: p1.x + ((p2.x - p1.x) * rr) / d2, y: p1.y + ((p2.y - p1.y) * rr) / d2 };
    d += `L${a.x},${a.y}Q${p1.x},${p1.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d}L${last.x},${last.y}`;
}

function midpoint(pts: readonly Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= half && len > 0) return { x: a.x + ((b.x - a.x) * half) / len, y: a.y + ((b.y - a.y) * half) / len };
    half -= len;
  }
  return pts[0] ?? { x: 0, y: 0 };
}

const strokeWidth = (e: SceneEdge) => {
  const base = Math.min(4, 1 + Math.log2(1 + e.weight) * 0.55);
  return e.kind === "import" || e.kind === "uses" || e.kind === "config" ? Math.max(1, base * 0.75) : base;
};

const MARKER_KINDS = ["import", "call", "http", "data", "event", "queue", "extends", "config", "uses", "contains", "step"] as const;

export function Graph(p: GraphProps): JSX.Element {
  const { ix, version, state } = useApp();
  const { scene } = p;
  const uid = useMemo(() => `g${++graphSeq}`, []);
  const [layout, setLayout] = useState<Layout | undefined>(() => cachedLayout(version, scene));
  const [hover, setHover] = useState<string | undefined>();
  const [focusId, setFocusId] = useState<string | undefined>();
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const cam = useRef<Cam>({ x: 0, y: 0, k: 1 });
  const anim = useRef<number>(0);

  useEffect(() => {
    let alive = true;
    const hit = cachedLayout(version, scene);
    setLayout(hit);
    if (hit) return;
    layoutScene(version, scene).then(
      (l) => {
        perfStep("layout");
        if (alive) setLayout(l);
      },
      () => {},
    );
    return () => {
      alive = false;
      releaseLayout(version, scene);
    };
  }, [scene, version]);

  const apply = () => {
    const c = cam.current;
    world.current?.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
    if (svg.current) svg.current.dataset.zoom = c.k < 0.45 ? "far" : c.k < 0.75 ? "mid" : "near";
    cameras.set(scene.key, { ...c });
  };

  const viewport = () => ({ w: wrap.current?.clientWidth || 800, h: wrap.current?.clientHeight || 600 });

  const moveTo = (target: Cam, animate = true) => {
    cancelAnimationFrame(anim.current);
    if (!animate || reducedMotion()) {
      cam.current = target;
      apply();
      return;
    }
    const from = { ...cam.current };
    const start = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - start) / 180);
      const e = 1 - (1 - u) ** 3;
      cam.current = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      apply();
      if (u < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };

  const fitCam = (): Cam | undefined => {
    if (!layout) return undefined;
    const { w, h } = viewport();
    const lw = Math.max(1, layout.width);
    const lh = Math.max(1, layout.height);
    const k = Math.max(MIN_K, Math.min(FIT_MAX_K, (w - 48) / lw, (h - 96) / lh));
    return { k, x: (w - lw * k) / 2, y: Math.max(56, (h - lh * k) / 2) };
  };
  const fitView = (animate = true) => {
    const c = fitCam();
    if (c) moveTo(c, animate);
  };

  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    const { w, h } = viewport();
    const c = cam.current;
    const px = cx ?? w / 2;
    const py = cy ?? h / 2;
    const k = Math.max(MIN_K, Math.min(MAX_K, c.k * factor));
    const r = k / c.k;
    cam.current = { k, x: px - (px - c.x) * r, y: py - (py - c.y) * r };
    apply();
  };

  // First layout of a key: fit; later visits restore the camera.
  useLayoutEffect(() => {
    if (!layout) return;
    perfPainted(`${scene.nodes.length} nodes, ${scene.edges.length} edges`);
    const saved = cameras.get(scene.key);
    if (saved) {
      cam.current = { ...saved };
      apply();
    } else fitView(false);
  }, [layout]);

  // Centre on a node on request (search, flow step, tour stop).
  useLayoutEffect(() => {
    if (!layout || !p.center) return;
    const box = layout.nodes.get(p.center.id);
    if (!box) return;
    const whole = fitCam();
    // A graph that fits at a readable size is shown whole; a big one centres on the node.
    if (whole && whole.k >= 0.7) {
      moveTo(whole);
      return;
    }
    const { w, h } = viewport();
    const k = Math.max(cam.current.k, 0.8);
    moveTo({ k, x: w / 2 - (box.x + box.w / 2) * k, y: h / 2 - (box.y + box.h / 2) * k });
  }, [layout, p.center?.nonce, p.center?.id]);

  // Expose fit / zoom to the toolbar through DOM events on the wrapper.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onCmd = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (cmd === "fit") fitView();
      else if (cmd === "in") zoomBy(1.25);
      else if (cmd === "out") zoomBy(0.8);
    };
    el.addEventListener("graph-cmd", onCmd);
    return () => el.removeEventListener("graph-cmd", onCmd);
  });

  // Wheel: zoom around the pointer (pinch arrives as ctrl+wheel); horizontal scroll pans.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        cam.current = { ...cam.current, x: cam.current.x - e.deltaX };
        apply();
        return;
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // Drag to pan, two pointers to pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean; pinch?: number } | undefined>(undefined);
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { x: 0, y: 0, moved: true, pinch: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
    } else drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !drag.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (d.pinch && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const rect = svg.current!.getBoundingClientRect();
      zoomBy(dist / d.pinch, (a!.x + b!.x) / 2 - rect.left, (a!.y + b!.y) / 2 - rect.top);
      d.pinch = dist;
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    // Capture only once it is a drag, so a plain click still reaches the card under the pointer.
    if (!d.moved) svg.current?.setPointerCapture?.(e.pointerId);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    cam.current = { ...cam.current, x: cam.current.x + dx, y: cam.current.y + dy };
    apply();
  };
  const onPointerUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) setTimeout(() => (drag.current = undefined), 0);
  };
  const wasDrag = () => !!drag.current?.moved;

  const byId = useMemo(() => new Map(scene.nodes.map((n) => [n.id, n])), [scene]);
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    for (const e of scene.edges) {
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      if (!adj.has(e.to)) adj.set(e.to, new Set());
      adj.get(e.from)!.add(e.to);
      adj.get(e.to)!.add(e.from);
    }
    return adj;
  }, [scene]);

  const lit = hover ?? undefined;
  const near = lit ? adjacency.get(lit) : undefined;
  const isLit = (id: string) => !lit || id === lit || !!near?.has(id) || byId.get(id)?.role === "group";

  // Roving focus: one tabbable node; arrows move to the nearest node in that direction.
  const cards = scene.nodes.filter((n) => n.role !== "group");
  const tabbable = focusId && byId.has(focusId) ? focusId : p.selected && byId.has(p.selected) ? p.selected : cards[0]?.id;
  const focusNode = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      const el = svg.current?.querySelector<SVGGElement>(`[data-id="${CSS.escape(id)}"]`);
      el?.focus({ preventScroll: true });
      const box = layout?.nodes.get(id);
      if (box) {
        // keep the focused node on screen
        const { w, h } = viewport();
        const c = cam.current;
        const sx = box.x * c.k + c.x;
        const sy = box.y * c.k + c.y;
        if (sx < 16 || sy < 48 || sx + box.w * c.k > w - 16 || sy + box.h * c.k > h - 16)
          moveTo({ ...c, x: w / 2 - (box.x + box.w / 2) * c.k, y: h / 2 - (box.y + box.h / 2) * c.k });
      }
    });
  };
  const nearestIn = (from: string, dir: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"): string | undefined => {
    const a = layout?.nodes.get(from);
    if (!a) return undefined;
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    let best: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const n of cards) {
      if (n.id === from) continue;
      const b = layout!.nodes.get(n.id);
      if (!b) continue;
      const dx = b.x + b.w / 2 - ax;
      const dy = b.y + b.h / 2 - ay;
      const along = dir === "ArrowRight" ? dx : dir === "ArrowLeft" ? -dx : dir === "ArrowDown" ? dy : -dy;
      const across = dir === "ArrowRight" || dir === "ArrowLeft" ? Math.abs(dy) : Math.abs(dx);
      if (along <= 1) continue;
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = n.id;
      }
    }
    return best;
  };

  const onNodeKey = (n: SceneNode, e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      p.onActivate?.(n);
    } else if (e.key === " ") {
      e.preventDefault();
      p.onSelect(n);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      const next = nearestIn(n.id, e.key);
      if (next) focusNode(next);
    } else if (e.key === "Escape" && p.selected) {
      e.stopPropagation();
      p.onSelect(undefined);
    }
  };
  const onCanvasKey = (e: KeyboardEvent) => {
    const step = 60;
    const c = cam.current;
    switch (e.key) {
      case "+":
      case "=":
        zoomBy(1.2);
        break;
      case "-":
      case "_":
        zoomBy(1 / 1.2);
        break;
      case "0":
        fitView();
        break;
      case "ArrowLeft":
        cam.current = { ...c, x: c.x + step };
        apply();
        break;
      case "ArrowRight":
        cam.current = { ...c, x: c.x - step };
        apply();
        break;
      case "ArrowUp":
        cam.current = { ...c, y: c.y + step };
        apply();
        break;
      case "ArrowDown":
        cam.current = { ...c, y: c.y - step };
        apply();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const markerFor = (e: SceneEdge) => `url(#${uid}-ah-${e.kind})`;
  const ghostEdge = (e: SceneEdge) => byId.get(e.from)?.role === "ghost" || byId.get(e.to)?.role === "ghost";

  const renderEdge = (e: SceneEdge) => {
    const pts = layout?.edges.get(e.id);
    if (!pts) return null;
    const d = roundedPath(pts);
    const w = strokeWidth(e);
    const on = !lit || e.from === lit || e.to === lit;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    const title = `${from ? sceneLabel(from) : e.from} → ${to ? sceneLabel(to) : e.to}: ${e.kinds.map((k) => t(`edge.${k}`)).join(", ")} (${t("graph.refs", { count: e.weight })})`;
    const double = e.kind === "event" || e.kind === "queue";
    const mid = e.label && p.variant === "erd" ? midpoint(pts) : undefined;
    return (
      <g
        key={e.id}
        class={`e k-${e.kind}${on && lit ? " hl" : ""}${ghostEdge(e) ? " ghosty" : ""}${p.spotlight && (p.spotlight.has(e.from) && p.spotlight.has(e.to)) ? " spot" : ""}`}
      >
        <title>{title}</title>
        <path class="e-hit" d={d} />
        {double ? <path class="e-under" d={d} style={{ strokeWidth: w + 3 }} /> : null}
        <path class="e-line" d={d} style={{ strokeWidth: double ? Math.max(1, w - 0.5) : w }} marker-end={markerFor(e)} />
        {mid ? (
          <text class="e-label" x={mid.x} y={mid.y - 6} text-anchor="middle">
            {e.label}
          </text>
        ) : null}
      </g>
    );
  };

  const capStrip = (n: SceneNode, box: Box) => {
    const node = ix.byId.get(n.ref);
    const caps = n.kind === "cap" ? [n.ref] : (node?.caps ?? []).slice(0, 4);
    if (!caps.length) return null;
    const x0 = 12;
    const x1 = box.w - 12;
    const gap = 3;
    const seg = (x1 - x0 - gap * (caps.length - 1)) / caps.length;
    return (
      <g class="strip">
        {caps.map((c, i) => (
          <rect key={c} x={x0 + i * (seg + gap)} y={box.h - 5} width={seg} height={2.5} rx={1.25} style={{ fill: capVar(ix, c) }} />
        ))}
      </g>
    );
  };

  const renderGroup = (n: SceneNode, box: Box) => {
    const sel = p.selected === n.id;
    return (
      <g key={n.id} class={`grp k-${n.kind}${sel ? " sel" : ""}`} transform={`translate(${box.x} ${box.y})`}>
        <rect class="grp-bg" width={box.w} height={box.h} rx={14} />
        <g
          class="grp-head"
          data-id={n.id}
          role="button"
          tabIndex={tabbable === n.id ? 0 : -1}
          aria-label={`${kindName(n.kind)}: ${n.label}. ${t("graph.groupHint")}`}
          aria-pressed={sel}
          onClick={(e) => {
            e.stopPropagation();
            if (!wasDrag()) p.onSelect(n);
          }}
          onDblClick={(e) => {
            e.stopPropagation();
            p.onActivate?.(n);
          }}
          onKeyDown={(e) => onNodeKey(n, e)}
          onFocus={() => setFocusId(n.id)}
        >
          <rect class="grp-hit" x={0} y={0} width={box.w} height={34} rx={14} />
          <Glyph name={n.kind} x={14} y={10} size={14} />
          <text class="grp-label" x={34} y={21.5}>
            {ellipsize(n.label, box.w - 48, 12, 600)}
          </text>
        </g>
      </g>
    );
  };

  const renderErdBody = (n: SceneNode, box: Box) => {
    const fields = ix.byId.get(n.ref)?.fields ?? [];
    const shown = fields.slice(0, ERD_MAX_FIELDS);
    const half = box.w / 2;
    return (
      <g class="erd-rows">
        <line class="erd-rule" x1={0} x2={box.w} y1={ERD_HEAD} y2={ERD_HEAD} />
        {shown.map((f, i) => {
          const y = ERD_HEAD + 14 + i * ERD_ROW;
          return (
            <g key={f.name}>
              <text class={`erd-name${f.relation ? " rel" : ""}`} x={14} y={y}>
                {ellipsize(f.name, half - 18, 12, f.relation ? 600 : 400)}
              </text>
              <text class="erd-type" x={box.w - 14} y={y} text-anchor="end">
                {ellipsize(f.type, half - 18, 11.5)}
              </text>
            </g>
          );
        })}
        {fields.length > ERD_MAX_FIELDS ? (
          <text class="erd-more" x={14} y={ERD_HEAD + 14 + shown.length * ERD_ROW}>
            {t("graph.moreFields", { count: fields.length - ERD_MAX_FIELDS })}
          </text>
        ) : null}
      </g>
    );
  };

  const renderNode = (n: SceneNode, box: Box) => {
    const node = ix.byId.get(n.ref);
    const sel = p.selected === n.id;
    const ov = p.overlay?.get(n.id);
    const spot = p.spotlight?.has(n.id);
    const badge = p.badges?.get(n.id);
    const cls = `n r-${n.role} k-${n.kind}${sel ? " sel" : ""}${isLit(n.id) && lit ? " hl" : ""}${spot ? " spot" : ""}${ov ? ` ov ov-${ov}` : ""}`;
    const agg = n.role === "agg";
    const chip = n.role === "chip" || agg;
    const ghost = n.role === "ghost";
    const cluster = n.role === "cluster";
    const folder = cluster && !!n.group;
    const erd = p.variant === "erd";
    const iconSize = chip || ghost ? 14 : 16;
    const iconBox = chip || ghost ? 0 : 30;
    const labelX = chip || ghost ? 32 : 52;
    const labelSize = chip || ghost ? 12 : 13;
    // A part of an over-full folder: "Part 2" on top, its first – last names below.
    const label = n.part !== undefined ? t("map.part", { n: n.part + 1 }) : sceneLabel(n);
    const subMax = box.w - labelX - 12;
    const sub = folder
      ? fitParts(n.part !== undefined ? [n.label] : groupParts(n.counts ?? {}), subMax, 11.5)
      : cluster && n.count
        ? t("graph.clusterCount", { count: n.count, kind: "" })
        : node && !chip && !ghost && !erd
          ? fitParts(sublineParts(ix, node, state.audience), subMax, 11.5)
          : "";
    const capColor = n.kind === "cap" ? capVar(ix, n.ref) : node?.caps[0] ? capVar(ix, node.caps[0]) : "var(--cap-none)";
    const aria = folder
      ? `${t("kind.folder")}: ${sceneLabel(n)}. ${groupParts(n.counts ?? {}).join(", ")}. ${t("graph.folderHint")}`
      : agg
        ? `${label}. ${t(n.kind === "entity" ? "graph.aggDataHint" : "graph.aggHint")}`
        : node
          ? describeNode(ix, node, state.audience)
          : `${kindName(n.kind)}: ${label}`;
    return (
      <g
        key={n.id}
        class={cls}
        data-id={n.id}
        transform={`translate(${box.x} ${box.y})`}
        role="button"
        tabIndex={tabbable === n.id ? 0 : -1}
        aria-label={`${aria}${cluster && !folder ? `. ${t("graph.clusterHint")}` : ""}${ghost ? `. ${t("graph.ghostHint")}` : ""}`}
        aria-pressed={sel}
        onClick={(e) => {
          e.stopPropagation();
          if (!wasDrag()) p.onSelect(n);
        }}
        onDblClick={(e) => {
          e.stopPropagation();
          p.onActivate?.(n);
        }}
        onKeyDown={(e) => onNodeKey(n, e)}
        onFocus={() => setFocusId(n.id)}
        onPointerEnter={() => setHover(n.id)}
        onPointerLeave={() => setHover((h) => (h === n.id ? undefined : h))}
      >
        {cluster ? (
          <>
            <rect class="stack" x={8} y={-8} width={box.w - 16} height={box.h} rx={12} />
            <rect class="stack" x={4} y={-4} width={box.w - 8} height={box.h} rx={12} />
          </>
        ) : agg ? (
          <rect class="stack" x={5} y={-5} width={box.w - 10} height={box.h} rx={9} />
        ) : null}
        <rect class="bg" width={box.w} height={box.h} rx={chip ? 9 : 12} />
        {iconBox ? (
          <rect class="ico-bg" x={12} y={erd ? 6 : (box.h - iconBox) / 2 - (sub ? 0 : 0)} width={iconBox} height={iconBox} rx={8} style={{ fill: capColor }} />
        ) : null}
        <Glyph
          name={folder ? "folder" : cluster ? "cluster" : n.kind}
          x={iconBox ? 12 + (iconBox - iconSize) / 2 : 11}
          y={iconBox ? (erd ? 6 : (box.h - iconBox) / 2) + (iconBox - iconSize) / 2 : (box.h - iconSize) / 2}
          size={iconSize}
        />
        <text class="label" x={labelX} y={erd ? 25 : sub ? box.h / 2 - 3 : box.h / 2 + 4.5} style={{ fontSize: `${labelSize}px` }}>
          {ellipsize(label, box.w - labelX - (badge ? 34 : 12), labelSize, 600)}
        </text>
        {sub ? (
          <text class="sub" x={labelX} y={box.h / 2 + 14}>
            {sub}
          </text>
        ) : null}
        {erd ? renderErdBody(n, box) : null}
        {!chip && !ghost && !erd ? capStrip(n, box) : null}
        {badge ? (
          <g class="badge" transform={`translate(${box.w - 14} 14)`}>
            <circle r={10} />
            <text y={4} text-anchor="middle">
              {badge}
            </text>
          </g>
        ) : null}
        {ov ? (
          <g class="ov-badge" transform={`translate(${box.w - 8} ${-6})`}>
            <rect x={-44} y={-8} width={52} height={16} rx={8} />
            <text x={-18} y={4} text-anchor="middle">
              {t(`change.${ov}`)}
            </text>
          </g>
        ) : null}
      </g>
    );
  };

  const groups = layout ? scene.nodes.filter((n) => n.role === "group") : [];
  const items = layout ? scene.nodes.filter((n) => n.role !== "group") : [];
  const loading = !layout && scene.nodes.length > 0;

  return (
    <div class={`graph${p.variant === "erd" ? " erd" : ""}`} ref={wrap}>
      <svg
        ref={svg}
        class={`graph-svg${lit ? " has-hover" : ""}${p.spotlight?.size ? " has-spot" : ""}`}
        role="group"
        aria-roledescription={t("graph.roledesc")}
        aria-label={p.label}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => {
          if (!wasDrag()) p.onSelect(undefined);
        }}
        onKeyDown={onCanvasKey}
      >
        <defs>
          {MARKER_KINDS.map((k) => (
            <marker
              key={k}
              id={`${uid}-ah-${k}`}
              class={`ah k-${k}`}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d={k === "extends" ? "M1,1 L9,5 L1,9 Z" : "M1,1.5 L9,5 L1,8.5 L3,5 Z"} />
            </marker>
          ))}
        </defs>
        <g ref={world}>
          {groups.map((n) => {
            const box = layout!.nodes.get(n.id);
            return box ? renderGroup(n, box) : null;
          })}
          <g class="edges">{layout ? scene.edges.map(renderEdge) : null}</g>
          {items.map((n) => {
            const box = layout!.nodes.get(n.id);
            return box ? renderNode(n, box) : null;
          })}
        </g>
      </svg>
      {loading ? (
        <div class="graph-loading" role="status">
          <span class="spinner" aria-hidden="true" />
          {t("graph.laying")}
        </div>
      ) : null}
      {layout?.engine === "grid" ? (
        <div class="graph-note" role="note">
          <Icon name="warning" size={14} />
          {t("graph.gridFallback")}
        </div>
      ) : null}
    </div>
  );
}

/** Ask the graph inside `root` to fit / zoom (toolbar buttons). */
export function graphCommand(root: Element | null, cmd: "fit" | "in" | "out"): void {
  root?.querySelector(".graph")?.dispatchEvent(new CustomEvent("graph-cmd", { detail: cmd }));
}
