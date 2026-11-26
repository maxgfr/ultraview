// `ultraview export --mermaid|--md|--svg` (docs/design.md §7): the map for
// READMEs, wikis and PRs, from the live view-model. Deterministic: the same map
// gives the same bytes.
//
//   --mermaid  a flowchart at one level (cap | sys | mod), or of one lens / flow
//   --svg      the same subgraph, laid out here (layered, left to right) as SVG
//   --md       an architecture brief: app, systems, capabilities with their
//              cited summaries, data, externals, flows, top insights
//
// Subgraphs are cut to MERMAID_MAX_NODES nodes / MERMAID_MAX_EDGES edges, most
// central first (PageRank, then id).

import { resolve } from "node:path";
import { loadGraph } from "./engine.js";
import { insightsOf } from "./insights.js";
import { MERMAID_MAX_EDGES, MERMAID_MAX_NODES, mermaidFlowchart, type Pick, type PickedEdge } from "./mermaid.js";
import { assembleView } from "./model/assemble.js";
import { FOUNDATIONS_CAP, kindOf } from "./model/ids.js";
import { loadViewInputs } from "./model/load.js";
import type { NodeKind, ViewModel, ViewNode } from "./model/types.js";
import { viewPaths } from "./paths.js";

export const EXPORT_LEVELS = ["cap", "sys", "mod"] as const;
export type ExportLevel = (typeof EXPORT_LEVELS)[number];
export const EXPORT_FORMATS = ["mermaid", "md", "svg"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Insights listed in the brief, at most. */
export const BRIEF_INSIGHTS = 10;

export interface ExportOptions {
  level?: ExportLevel;
  lens?: string;
  flow?: string;
}

/** What each level shows besides its own kind: the business things that stay themselves at every level. */
const LEVEL_EXTRAS: Record<ExportLevel, NodeKind[]> = { cap: ["ext", "entity"], sys: ["ext"], mod: ["ext"] };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byRank = (a: ViewNode, b: ViewNode) => b.metrics.pagerank - a.metrics.pagerank || cmp(a.id, b.id);
const labelOf = (n: ViewNode) => (n.slice ? `${n.label} ${n.slice.qualifier}` : n.label);

/** View edges among `keep`, one per pair (weights summed, non-code kinds as the label), heaviest first. */
function edgesAmong(view: ViewModel, keep: ReadonlySet<string>): PickedEdge[] {
  const pairs = new Map<string, { from: string; to: string; weight: number; kinds: Set<string>; label?: string; declared: boolean }>();
  for (const e of view.edges) {
    if (e.from === e.to || !keep.has(e.from) || !keep.has(e.to) || e.kind === "contains") continue;
    const key = `${e.from}\n${e.to}`;
    const p = pairs.get(key) ?? { from: e.from, to: e.to, weight: 0, kinds: new Set(), declared: false };
    p.weight += e.weight;
    if (e.kind !== "import" && e.kind !== "call" && e.kind !== "extends") p.kinds.add(e.kind);
    if (!e.derived) {
      p.declared = true;
      if (e.label) p.label ??= e.label;
    }
    pairs.set(key, p);
  }
  return [...pairs.values()]
    .sort((a, b) => b.weight - a.weight || cmp(a.from, b.from) || cmp(a.to, b.to))
    .slice(0, MERMAID_MAX_EDGES)
    .map((p) => {
      const label = p.label ?? ([...p.kinds].sort().join("+") || undefined);
      return { from: p.from, to: p.to, ...(label ? { label } : {}), ...(p.declared ? { dotted: true } : {}) };
    });
}

/** The subgraph an export draws. Throws on an unknown lens / flow id. */
export function pickView(view: ViewModel, opts: ExportOptions = {}): Pick {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const asPicked = (n: ViewNode, cls?: string) => ({ id: n.id, label: labelOf(n), kind: n.kind, ...(cls ? { cls } : {}) });
  if (opts.lens !== undefined) {
    const lens = view.lenses.find((l) => l.id === opts.lens);
    if (!lens) throw new Error(`unknown lens "${opts.lens}" (saved: ${view.lenses.map((l) => l.id).join(", ") || "none"})`);
    const nodes = lens.nodes.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])).slice(0, MERMAID_MAX_NODES);
    const keep = new Set(nodes.map((n) => n.id));
    const declared = (lens.edges ?? [])
      .filter((e) => keep.has(e.from) && keep.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, ...(e.kind ? { label: e.kind } : {}) }));
    const seen = new Set(declared.map((e) => `${e.from}\n${e.to}`));
    return {
      nodes: nodes.map((n) => asPicked(n, n.id === lens.focus ? "focus" : undefined)),
      edges: [...declared, ...edgesAmong(view, keep).filter((e) => !seen.has(`${e.from}\n${e.to}`))].slice(0, MERMAID_MAX_EDGES),
    };
  }
  if (opts.flow !== undefined) {
    const flow = view.flows.find((f) => f.id === opts.flow);
    if (!flow) throw new Error(`unknown flow "${opts.flow}" (saved: ${view.flows.map((f) => f.id).join(", ") || "none"})`);
    const order = [...(flow.trigger ? [flow.trigger] : []), ...flow.steps.map((s) => s.node)].filter((id) => byId.has(id));
    const nodes = [...new Set(order)].slice(0, MERMAID_MAX_NODES);
    const keep = new Set(nodes);
    const edges: PickedEdge[] = [];
    for (let i = 1; i < order.length; i++) {
      const [from, to] = [order[i - 1]!, order[i]!];
      if (from !== to && keep.has(from) && keep.has(to)) edges.push({ from, to, label: String(edges.length + 1) });
    }
    return { nodes: nodes.map((id) => asPicked(byId.get(id)!, flow.trigger === id ? "focus" : undefined)), edges: edges.slice(0, MERMAID_MAX_EDGES) };
  }
  const level = opts.level ?? "sys";
  const primary = view.nodes
    .filter((n) => n.kind === level)
    .sort(byRank)
    .slice(0, MERMAID_MAX_NODES);
  const prim = new Set(primary.map((n) => n.id));
  const extraWeight = new Map<string, number>();
  for (const e of view.edges) {
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      if (prim.has(a) && LEVEL_EXTRAS[level].includes(kindOf(b)!)) extraWeight.set(b, (extraWeight.get(b) ?? 0) + e.weight);
    }
  }
  const extras = [...extraWeight]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, MERMAID_MAX_NODES - primary.length)
    .map(([id]) => byId.get(id)!);
  const nodes = [...primary, ...extras];
  return { nodes: nodes.map((n) => asPicked(n, n.id === FOUNDATIONS_CAP ? "derived" : undefined)), edges: edgesAmong(view, new Set(nodes.map((n) => n.id))) };
}

const EXPORT_CLASSES = { focus: "stroke-width:3px", derived: "stroke-dasharray:4 2" };

export function exportMermaid(view: ViewModel, opts: ExportOptions = {}): string {
  return mermaidFlowchart(pickView(view, opts), { classes: EXPORT_CLASSES });
}

// --- SVG: a small layered layout (longest path, barycentre ordering) ---------------

const NODE_W = 180;
const NODE_H = 40;
const GAP_X = 70;
const GAP_Y = 22;
const PAD = 20;
const LABEL_MAX = 24;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FILL: Partial<Record<NodeKind, string>> = { cap: "#eef4ff", sys: "#f4f3ff", mod: "#f9fafb", ext: "#fff6ed", entity: "#ecfdf3" };

/** The picked subgraph as a standalone SVG: layers left to right, edges as curves. */
export function exportSvg(view: ViewModel, opts: ExportOptions = {}): string {
  const pick = pickView(view, opts);
  const ids = pick.nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const edges = pick.edges.filter((e) => out.has(e.from) && out.has(e.to));
  for (const e of edges) out.get(e.from)!.push(e.to);
  // Break cycles: a DFS in id order drops back edges from the layering.
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]));
  const state = new Map<string, number>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of [...out.get(id)!].sort(cmp)) {
      if (state.get(to) === 1) continue;
      forward.get(id)!.push(to);
      if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const id of [...ids].sort(cmp)) if (!state.has(id)) visit(id);
  // Longest path from the sources.
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let changed = true, guard = 0; changed && guard <= ids.length; guard++) {
    changed = false;
    for (const [from, tos] of forward) {
      for (const to of tos) {
        if (layer.get(to)! <= layer.get(from)!) {
          layer.set(to, layer.get(from)! + 1);
          changed = true;
        }
      }
    }
  }
  const layers: string[][] = [];
  for (const id of [...ids].sort(cmp)) (layers[layer.get(id)!] ??= []).push(id);
  // One barycentre pass, left to right: a node sits near the mean row of its predecessors.
  const row = new Map<string, number>();
  layers.forEach((ls, x) => {
    if (x > 0) {
      const bary = (id: string) => {
        const ps = edges.filter((e) => e.to === id && layer.get(e.from)! < x).map((e) => row.get(e.from)!);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.POSITIVE_INFINITY;
      };
      ls.sort((a, b) => bary(a) - bary(b) || cmp(a, b));
    }
    ls.forEach((id, y) => row.set(id, y));
  });
  const pos = (id: string) => ({ x: PAD + layer.get(id)! * (NODE_W + GAP_X), y: PAD + row.get(id)! * (NODE_H + GAP_Y) });
  const width = PAD * 2 + Math.max(1, layers.length) * NODE_W + Math.max(0, layers.length - 1) * GAP_X;
  const height = PAD * 2 + Math.max(1, ...layers.map((l) => l.length)) * (NODE_H + GAP_Y) - GAP_Y;
  const byId = new Map(pick.nodes.map((n) => [n.id, n]));
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif" font-size="13">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#667085"/></marker></defs>`,
  ];
  for (const e of edges) {
    const a = pos(e.from);
    const b = pos(e.to);
    const [x1, y1] = [a.x + NODE_W, a.y + NODE_H / 2];
    const [x2, y2] = [b.x, b.y + NODE_H / 2];
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    lines.push(
      `<path d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}" fill="none" stroke="#98a2b3" stroke-width="1.5"${e.dotted ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#arrow)"/>`,
    );
    if (e.label)
      lines.push(
        `<text x="${Math.round((x1 + x2) / 2)}" y="${Math.round((y1 + y2) / 2) - 4}" text-anchor="middle" fill="#475467" font-size="11">${xml(e.label)}</text>`,
      );
  }
  for (const id of ids) {
    const n = byId.get(id)!;
    const { x, y } = pos(id);
    const text = n.label.length > LABEL_MAX ? `${n.label.slice(0, LABEL_MAX - 1)}…` : n.label;
    lines.push(
      `<g><title>${xml(n.label)}</title><rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${(n.kind && FILL[n.kind]) || "#ffffff"}" stroke="#475467" stroke-width="${n.cls === "focus" ? 3 : 1}"${n.cls === "derived" ? ' stroke-dasharray="4 2"' : ""}/><text x="${x + NODE_W / 2}" y="${y + NODE_H / 2 + 4}" text-anchor="middle" fill="#101828">${xml(text)}</text></g>`,
    );
  }
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

// --- Markdown brief ---------------------------------------------------------------

const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** An architecture brief in Markdown (README / wiki): every summary keeps its `[path:line]` citations. */
export function exportBrief(view: ViewModel): string {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  // Derived catch-alls (Unassigned, Shared foundations) after the declared ones.
  const kinds = (kind: NodeKind) =>
    view.nodes.filter((n) => n.kind === kind).sort((a, b) => Number(a.tags.includes("derived")) - Number(b.tags.includes("derived")) || cmp(a.id, b.id));
  const out = [`# ${view.app.name}`, ""];
  if (view.app.summary) out.push(view.app.summary, "");
  const systems = kinds("sys");
  if (systems.length) {
    out.push("## Systems", "", "| System | Kind | Files | Lines | Summary |", "|---|---|---|---|---|");
    for (const s of systems) {
      const files = view.nodes.filter((n) => n.kind === "file" && byId.get(n.parent ?? "")?.parent === s.id).length;
      out.push(`| ${cell(s.label)} | ${s.role ?? "—"} | ${files} | ${s.metrics.loc} | ${cell(s.summary) || "—"} |`);
    }
    out.push("");
  }
  const caps = kinds("cap");
  if (caps.length) {
    out.push("## Capabilities", "");
    for (const c of caps) {
      out.push(`### ${c.label}`, "");
      if (c.summary) out.push(c.summary, "");
      const serving = (k: NodeKind) => view.nodes.filter((n) => n.kind === k && n.caps.includes(c.id));
      const sys = serving("sys").map((n) => n.label);
      const routes = serving("route").map((n) => `\`${n.label}\``);
      const entities = serving("entity").map((n) => n.label);
      if (c.actors?.length) out.push(`- Used by: ${c.actors.join(", ")}`);
      if (sys.length) out.push(`- Systems: ${sys.join(", ")}`);
      if (routes.length) out.push(`- Routes: ${routes.join(", ")}`);
      if (entities.length) out.push(`- Data: ${entities.join(", ")}`);
      out.push(`- Size: ${c.metrics.loc} lines${c.cites.length ? `; evidence: ${c.cites.map((x) => `\`${x}\``).join(", ")}` : ""}`, "");
    }
  }
  const entities = kinds("entity");
  if (entities.length) {
    out.push("## Data", "", "| Entity | Fields | Defined at |", "|---|---|---|");
    for (const e of entities)
      out.push(
        `| ${cell(e.label)} | ${cell((e.fields ?? []).map((f) => (f.relation ? `${f.name} → ${f.relation}` : f.name)).join(", ")) || "—"} | \`${e.at ?? ""}\` |`,
      );
    out.push("");
  }
  const exts = kinds("ext");
  if (exts.length) {
    out.push("## External services", "");
    for (const x of exts) out.push(`- **${x.label}** (${x.tags.join(", ") || "detected"})${x.at ? `: \`${x.at}\`` : ""}`);
    out.push("");
  }
  if (view.flows.length) {
    out.push("## Flows", "");
    for (const f of view.flows) {
      out.push(`### ${f.title}`, "");
      f.steps.forEach((s, i) => {
        out.push(`${i + 1}. **${byId.get(s.node) ? labelOf(byId.get(s.node)!) : s.node}**: ${s.note}`);
      });
      out.push("");
    }
  }
  if (view.insights.length) {
    out.push("## Insights", "");
    for (const i of view.insights.slice(0, BRIEF_INSIGHTS)) out.push(`- **${i.severity}** ${i.title}: ${i.detail}`);
    out.push("");
  }
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  out.push(
    `_Coverage: ${pct(view.coverage.filesInSystems)} of code files in systems, ${pct(view.coverage.modulesInCapabilities)} of modules in capabilities._`,
  );
  return `${out.join("\n")}\n`;
}

/** The live view-model for an export (re-assembled from the index; insights only when asked, they read git). */
export function exportView(repoArg: string, opts: { insights?: boolean } = {}): ViewModel {
  const repo = resolve(repoArg);
  const graph = loadGraph(viewPaths(repo).index);
  if (!graph) throw new Error(`no ultraindex index at ${viewPaths(repo).index}: run \`ultraview build\` first`);
  const insights = opts.insights ? insightsOf(repo, { graph }) : [];
  return assembleView(loadViewInputs(repo, { graph, insights }).inputs);
}
