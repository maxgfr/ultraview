// The plain-text build summary an agent reads instead of facts.json: compact
// (at most SUMMARY_MAX_LINES lines), deterministic for a given build, and
// ending with the next step.

import type { MapBuildResult } from "./build.js";
import { FACT_KINDS, type FactKind, type Facts } from "./extract/index.js";

export const SUMMARY_MAX_LINES = 150;
const EXAMPLES = 5;

function describe(kind: FactKind, r: Record<string, any>): string {
  const at = `${r.file}:${r.line}`;
  switch (kind) {
    case "routes":
      return `${r.method} ${r.path}${r.handler ? ` -> ${r.handler}` : ""}  [${at}]`;
    case "calls":
      return `${r.method} ${r.url}${r.route ? ` -> ${r.route}` : ""}  [${at}]`;
    case "screens":
      return `${r.path} (${r.framework})  [${at}]`;
    case "entities": {
      const rels = (r.fields as { relation?: string }[]).filter((f) => f.relation).map((f) => f.relation);
      return `${r.name} (${r.orm}, ${r.fields.length} fields${rels.length ? `, -> ${[...new Set(rels)].join(", ")}` : ""})  [${at}]`;
    }
    case "entityUses":
      return `${r.entity} ${r.op}  [${at}]`;
    case "jobs":
      return `${r.id} (${r.kind}${r.schedule ? ` ${r.schedule}` : ""})  [${at}]`;
    case "externals":
      return `${r.id} via ${r.via}  [${at}]`;
    case "infra":
      return `${r.id} (${r.kind})  [${at}]`;
  }
}

export function factCounts(facts: Facts): Record<FactKind, number> {
  const out = {} as Record<FactKind, number>;
  for (const kind of FACT_KINDS) out[kind] = facts[kind].length;
  return out;
}

export function formatBuildSummary(r: MapBuildResult): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`ultraview build: ${r.name}`);
  const symbols = r.grammars.ast ? `AST (tree-sitter, ${r.grammars.tier})` : "regex fallback (no grammars loaded)";
  push(
    `index      ${r.index.files} files, ${r.index.modules} modules, ${r.index.edges} file edges${r.index.capped ? " (CAPPED: raise --max-files)" : ""}; symbols: ${symbols}`,
  );
  const langs = Object.entries(r.index.languages)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([l, n]) => `${l} ${n}`);
  push(`languages  ${langs.join(", ") || "(none)"}`);
  if (r.workspaces.length) {
    push(`workspaces ${r.workspaces.length}`);
    for (const w of r.workspaces.slice(0, 10)) push(`  ${w.name} (${w.dir || "."}, ${w.kind})`);
    if (r.workspaces.length > 10) push(`  … and ${r.workspaces.length - 10} more`);
  } else push("workspaces (single package)");

  push();
  push("top modules by PageRank");
  r.topModules.forEach((m, i) => {
    push(`  ${String(i + 1).padStart(2)}. ${m.slug.padEnd(28)} ${m.path || "."}  (${m.files} file${m.files === 1 ? "" : "s"}, pr ${m.pagerank.toFixed(3)})`);
  });
  if (!r.topModules.length) push("  (none)");

  push();
  push("facts");
  for (const kind of FACT_KINDS) {
    const rows = r.facts[kind] as unknown as Record<string, any>[];
    push(`  ${kind.padEnd(11)} ${rows.length}`);
    if (kind === "externals") continue;
    for (const row of rows.slice(0, EXAMPLES)) push(`    ${describe(kind, row)}`);
    if (rows.length > EXAMPLES) push(`    … and ${rows.length - EXAMPLES} more`);
  }

  push();
  const externals = [...new Set(r.facts.externals.map((e) => e.id))].sort();
  push(`externals  ${externals.length ? externals.join(", ") : "(none detected)"}`);

  if (r.failures.length) {
    push();
    push(`extractor errors ${r.failures.length} (facts from these files may be missing)`);
    for (const f of r.failures.slice(0, EXAMPLES)) push(`  ${f.extractor} on ${f.file}: ${f.message}`);
  }

  push();
  push(`written    ${r.written.join(", ")}`);
  push(
    r.hasModel
      ? "next step: run `ultraview status` to see what is stale, then re-describe only that."
      : "next step: read README, manifests and entrypoints, then write .ultraview/model.json (systems covering >= 90% of code files, then capabilities; every sentence cites [path:line]).",
  );

  if (lines.length > SUMMARY_MAX_LINES) {
    const kept = lines.slice(0, SUMMARY_MAX_LINES - 2);
    kept.push("… (summary truncated; run with --json for the full object)");
    kept.push(lines[lines.length - 1] as string);
    return `${kept.join("\n")}\n`;
  }
  return `${lines.join("\n")}\n`;
}
