// Mermaid flowcharts of a picked subgraph, for PR bodies (`diff --markdown`)
// and READMEs (`export --mermaid`). Deterministic: nodes and edges come in a
// fixed order, view ids become Mermaid-safe ids by one rule (`mermaidIds`), and
// labels are quoted with `"` escaped, so the same pick is the same text.

import type { NodeKind } from "./model/types.js";

/** Subgraphs are cut to this many nodes and edges (the most important first, as the picker ranks them). */
export const MERMAID_MAX_NODES = 40;
export const MERMAID_MAX_EDGES = 80;

export interface PickedNode {
  id: string;
  label: string;
  kind?: NodeKind;
  /** A class to style the node with (`added`, `changed`, …), declared in `classes`. */
  cls?: string;
}

export interface PickedEdge {
  from: string;
  to: string;
  label?: string;
  /** Drawn dotted (`-.->`) rather than solid. */
  dotted?: boolean;
}

export interface Pick {
  nodes: PickedNode[];
  edges: PickedEdge[];
}

export interface FlowchartOptions {
  direction?: "LR" | "TD";
  /** classDef name → its style (`fill:#…,stroke:#…`). */
  classes?: Record<string, string>;
  title?: string;
}

/**
 * Mermaid-safe ids for view ids, in the order given: every character outside
 * `[A-Za-z0-9_]` becomes `_`, a leading digit gets `n_`, and a collision gets
 * `_2`, `_3`, … in order of appearance.
 */
export function mermaidIds(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const id of ids) {
    if (out.has(id)) continue;
    let base = id.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(base)) base = `n_${base}`;
    let m = base;
    for (let i = 2; used.has(m); i++) m = `${base}_${i}`;
    used.add(m);
    out.set(id, m);
  }
  return out;
}

/** A label quoted for Mermaid: `"` and the characters Mermaid reads as markup become entities. */
export function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\r?\n/g, " ")}"`;
}

/** Node shape by kind: the open / close brackets around the quoted label. */
const SHAPES: Partial<Record<NodeKind, [string, string]>> = {
  cap: ["([", "])"],
  ext: ["{{", "}}"],
  entity: ["[(", ")]"],
  route: [">", "]"],
  screen: ["[/", "/]"],
  job: ["[[", "]]"],
  infra: ["[(", ")]"],
};

/** A flowchart of `pick`; edges whose ends are not both picked are dropped. */
export function mermaidFlowchart(pick: Pick, opts: FlowchartOptions = {}): string {
  const ids = mermaidIds(pick.nodes.map((n) => n.id));
  const lines: string[] = [];
  if (opts.title) lines.push("---", `title: ${opts.title.replace(/\r?\n/g, " ")}`, "---");
  lines.push(`flowchart ${opts.direction ?? "LR"}`);
  for (const n of pick.nodes) {
    const [open, close] = (n.kind && SHAPES[n.kind]) || ["[", "]"];
    lines.push(`  ${ids.get(n.id)}${open}${mermaidLabel(n.label)}${close}`);
  }
  for (const e of pick.edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to) continue;
    const arrow = e.dotted ? "-.->" : "-->";
    lines.push(`  ${from} ${arrow}${e.label ? `|${mermaidLabel(e.label)}|` : ""} ${to}`);
  }
  const classes = opts.classes ?? {};
  for (const [name, style] of Object.entries(classes)) {
    const members = pick.nodes.filter((n) => n.cls === name).map((n) => ids.get(n.id)!);
    if (!members.length) continue;
    lines.push(`  classDef ${name} ${style}`);
    lines.push(`  class ${members.join(",")} ${name}`);
  }
  return `${lines.join("\n")}\n`;
}
