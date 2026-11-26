// `ultraview insights`, as library calls (docs/design.md §6, §7): things worth
// a developer's attention, each built ONLY from an engine analysis and each
// carrying a ready prompt for the user's agent. No model in the loop.
//
//   hotspot          codeindex.rankHotspots (commits x log2(lines)) + riskHotspots (complexity)
//   hidden-coupling  codeindex.changeCoupling { hidden }: files that change together with no edge between them
//   cycle            codeindex.checkRules builtin "cycles": module-level import cycles
//   dead-code        codeindex.findDeadCode: exported symbols nothing references / calls
//   untested-hub     codeindex.untestedModules, ranked by incoming dependencies
//   literal          codeindex.findLiteralDuplications: the same literal inlined across files
//
// History (churn, coupling) reads git over a window that ends at HEAD's
// committer date, not at "now", so the same commit always gives the same
// numbers. Outside git, history-based kinds are simply absent and churn is 0.
//
// Never prints, never exits.

import { resolve } from "node:path";
import { codeindex, type Graph, loadGraph } from "./engine.js";
import { headState } from "./git.js";
import { fileId, modId, symId } from "./model/ids.js";
import { INSIGHT_KINDS, type Insight, type InsightKind, type Severity } from "./model/types.js";
import { viewPaths } from "./paths.js";
import { indexedScan, type RepoScan } from "./scan.js";

/** Churn and change coupling look at this many months of history before HEAD's commit date. */
export const CHURN_WINDOW_MONTHS = 6;
/** Insights kept, at most, overall and per kind. */
export const INSIGHTS_MAX = 30;
export const INSIGHTS_PER_KIND_MAX = 10;

/** hotspot: a non-test code file changed in at least this many commits of the window; medium / high from these. */
export const HOTSPOT_MIN_COMMITS = 5;
export const HOTSPOT_MEDIUM_COMMITS = 10;
export const HOTSPOT_HIGH_COMMITS = 20;
/** hidden-coupling: changed together at least this often, with at least this Wilson-lower-bound confidence; medium / high from these. */
export const COUPLING_MIN_TOGETHER = 3;
export const COUPLING_MIN_CONFIDENCE = 0.4;
export const COUPLING_MEDIUM_CONFIDENCE = 0.55;
export const COUPLING_HIGH_CONFIDENCE = 0.7;
/** cycle: modules in the loop for medium / high (2 = low). */
export const CYCLE_MEDIUM_MODULES = 3;
export const CYCLE_HIGH_MODULES = 4;
/** dead-code: this many unreferenced exports in one file is high; any unreferenced one is medium; only uncalled ones, low. */
export const DEAD_HIGH_SYMBOLS = 5;
/** untested-hub: an untested non-test module with at least this many incoming dependencies; medium / high from these. */
export const UNTESTED_HUB_MIN_DEG_IN = 3;
export const UNTESTED_HUB_MEDIUM_DEG_IN = 5;
export const UNTESTED_HUB_HIGH_DEG_IN = 10;
/** literal: tier → severity (competing constants are worst, a literal no constant holds the mildest). */
export const LITERAL_SEVERITY = { competing: "high", bypassed: "medium", uncentralized: "low" } as const;
/** Citations listed per insight, at most. */
export const INSIGHT_CITES_MAX = 10;

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const KIND_RANK = new Map<InsightKind, number>(INSIGHT_KINDS.map((k, i) => [k, i]));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clipText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const PREFIX = "Using ultraview and ultraindex,";

/** Git history over the churn window. `ok` false outside git (or with no commits): churn is then empty. */
export interface History {
  ok: boolean;
  /** First day of the window (`YYYY-MM-DD`), when measured. */
  since?: string;
  churn: Map<string, number>;
  commits: number;
}

/** The first day of a window of `months` ending at `date` (ISO), as `YYYY-MM-DD`. */
export function windowStart(date: string, months = CHURN_WINDOW_MONTHS): string {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Commits touching each file over the window before HEAD's commit date (codeindex.gitChurn). */
export function repoHistory(repoArg: string, months = CHURN_WINDOW_MONTHS): History {
  const repo = resolve(repoArg);
  const head = headState(repo);
  if (!head) return { ok: false, churn: new Map(), commits: 0 };
  const since = windowStart(head.date, months);
  const res = codeindex.gitChurn(repo, { since });
  return res.ok ? { ok: true, since, churn: res.churn, commits: res.commits } : { ok: false, churn: new Map(), commits: 0 };
}

export interface InsightContext {
  /** The graph (default: read from the index). */
  graph?: Graph;
  /** The engine scan (default: rebuilt from the index cache). */
  scan?: RepoScan;
  /** Git history (default: read now). */
  history?: History;
}

interface Ranked {
  insight: Insight;
  /** Higher first, within a kind. */
  score: number;
}

const make = (kind: InsightKind, key: string, severity: Severity, fields: Omit<Insight, "id" | "kind" | "severity">): Insight => ({
  id: `${kind}:${key}`,
  kind,
  severity,
  ...fields,
  nodes: [...new Set(fields.nodes)],
  cites: [...new Set(fields.cites)].slice(0, INSIGHT_CITES_MAX),
});

function hotspots(scan: RepoScan, history: History): Ranked[] {
  if (!history.ok) return [];
  const complexity = new Map(codeindex.riskHotspots(scan, history.churn, scan.files.length).map((r) => [r.file, r.complexity]));
  return codeindex
    .rankHotspots(scan, history.churn, scan.files.length)
    .filter((h) => !h.test && h.commits >= HOTSPOT_MIN_COMMITS)
    .map((h) => {
      const severity: Severity = h.commits >= HOTSPOT_HIGH_COMMITS ? "high" : h.commits >= HOTSPOT_MEDIUM_COMMITS ? "medium" : "low";
      const cx = complexity.get(h.rel);
      return {
        score: h.score,
        insight: make("hotspot", h.rel, severity, {
          title: `Hotspot: ${h.rel} changed in ${plural(h.commits, "commit")}`,
          detail: `${plural(h.commits, "commit")} since ${history.since} over ${plural(h.lines, "line")}${cx ? `, cyclomatic complexity ${cx}` : ""}: large and often changed, a likely place for bugs.`,
          nodes: [fileId(h.rel)],
          cites: [`${h.rel}:1`],
          prompt: `${PREFIX} review ${h.rel} (file:${h.rel}), changed in ${plural(h.commits, "commit")} over the last ${CHURN_WINDOW_MONTHS} months: explain why it keeps changing and propose a safe way to split or simplify it, citing files and lines.`,
        }),
      };
    });
}

function hiddenCouplings(repo: string, graph: Graph, history: History): Ranked[] {
  if (!history.ok) return [];
  const code = new Set(graph.files.filter((f) => f.fileKind === "code" && !f.testFile && !f.generated).map((f) => f.rel));
  const res = codeindex.changeCoupling(repo, { graph, hidden: true, since: history.since, minTogether: COUPLING_MIN_TOGETHER, maxPairs: 500 });
  if (!res.ok) return [];
  return res.couplings
    .filter((c) => code.has(c.a) && code.has(c.b) && c.confidence >= COUPLING_MIN_CONFIDENCE)
    .map((c) => {
      const severity: Severity = c.confidence >= COUPLING_HIGH_CONFIDENCE ? "high" : c.confidence >= COUPLING_MEDIUM_CONFIDENCE ? "medium" : "low";
      return {
        score: c.confidence * 1000 + c.together,
        insight: make("hidden-coupling", `${c.a}|${c.b}`, severity, {
          title: `Hidden coupling: ${c.a} and ${c.b} change together`,
          detail: `Changed together in ${c.together} of ${Math.min(c.totalA, c.totalB)} commits since ${history.since} (confidence ${c.confidence}), yet neither imports or calls the other.`,
          nodes: [fileId(c.a), fileId(c.b)],
          cites: [`${c.a}:1`, `${c.b}:1`],
          prompt: `${PREFIX} find out why ${c.a} and ${c.b} keep changing together although neither depends on the other, and propose how to make that dependency explicit or remove it, citing files.`,
        }),
      };
    });
}

function cycles(graph: Graph): Ranked[] {
  const pathOf = new Map(graph.modules.map((m) => [m.slug, m.path || "(root)"]));
  const moduleOf = new Map(graph.files.map((f) => [f.rel, f.module]));
  const out: Ranked[] = [];
  const seen = new Set<string>();
  for (const v of codeindex.checkRules(graph, [{ name: "cycles", builtin: "cycles" }])) {
    if (v.kind !== "cycle") continue;
    const loop = v.to.split(" -> ");
    if (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    const key = loop.join(">");
    if (loop.length < 2 || seen.has(key)) continue;
    seen.add(key);
    const cites: string[] = [];
    loop.forEach((from, i) => {
      const to = loop[(i + 1) % loop.length]!;
      const e = graph.fileEdges
        .filter((x) => x.kind === "import" && !x.dangling && moduleOf.get(x.from) === from && moduleOf.get(x.to) === to)
        .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to))[0];
      if (e) cites.push(`${e.from}:1`);
    });
    const names = loop.map((s) => pathOf.get(s) ?? s);
    const chain = [...names, names[0]].join(" → ");
    const severity: Severity = loop.length >= CYCLE_HIGH_MODULES ? "high" : loop.length >= CYCLE_MEDIUM_MODULES ? "medium" : "low";
    out.push({
      score: loop.length,
      insight: make("cycle", key, severity, {
        title: `Import cycle: ${chain}`,
        detail: `${plural(loop.length, "module")} import each other in a loop (${chain}): none of them can change or be tested alone.`,
        nodes: loop.map(modId),
        cites,
        prompt: `${PREFIX} propose a safe refactor to break the import cycle between ${names.join(", ")} (${loop.map(modId).join(", ")}), citing files.`,
      }),
    });
  }
  return out;
}

function deadCode(scan: RepoScan): Ranked[] {
  const byFile = new Map<string, ReturnType<typeof codeindex.findDeadCode>>();
  for (const d of codeindex.findDeadCode(scan)) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }
  return [...byFile].map(([file, syms]) => {
    syms.sort((a, b) => a.line - b.line || cmp(a.name, b.name));
    const unreferenced = syms.filter((s) => s.tier === "unreferenced");
    const severity: Severity = unreferenced.length >= DEAD_HIGH_SYMBOLS ? "high" : unreferenced.length ? "medium" : "low";
    const names = syms.map((s) => s.name);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
    const parts = [
      ...(unreferenced.length ? [`${plural(unreferenced.length, "exported symbol")} nothing references`] : []),
      ...(syms.length > unreferenced.length ? [`${plural(syms.length - unreferenced.length, "exported symbol")} referenced but never called`] : []),
    ];
    return {
      score: unreferenced.length * 100 + syms.length,
      insight: make("dead-code", file, severity, {
        title: `Unused exports in ${file}: ${shown}`,
        detail: `${parts.join("; ")} (${names.join(", ")}).`,
        nodes: [fileId(file), ...syms.map((s) => symId(file, s.name))],
        cites: syms.map((s) => `${file}:${s.line}`),
        prompt: `${PREFIX} check whether ${shown} in ${file} ${names.length === 1 ? "is" : "are"} really unused (dynamic imports, entry points, external consumers) and, if so, remove them safely, citing files.`,
      }),
    };
  });
}

function untestedHubs(graph: Graph): Ranked[] {
  const filesOf = new Map<string, typeof graph.files>();
  for (const f of graph.files) {
    const list = filesOf.get(f.module) ?? [];
    list.push(f);
    filesOf.set(f.module, list);
  }
  return codeindex
    .untestedModules(graph)
    .filter((m) => m.degIn >= UNTESTED_HUB_MIN_DEG_IN)
    .flatMap((m) => {
      const code = (filesOf.get(m.slug) ?? []).filter((f) => f.fileKind === "code" && !f.testFile && !f.generated);
      if (!code.length) return [];
      const top = [...code].sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0) || cmp(a.rel, b.rel))[0]!;
      const path = m.path || "(root)";
      const severity: Severity = m.degIn >= UNTESTED_HUB_HIGH_DEG_IN ? "high" : m.degIn >= UNTESTED_HUB_MEDIUM_DEG_IN ? "medium" : "low";
      return [
        {
          score: m.degIn * 1000 + (m.pagerank ?? 0),
          insight: make("untested-hub", m.slug, severity, {
            title: `Untested hub: ${path} (${plural(m.degIn, "incoming dependency", "incoming dependencies")}, no tests)`,
            detail: `${plural(m.degIn, "incoming dependency", "incoming dependencies")} reach ${path} (PageRank ${(m.pagerank ?? 0).toFixed(3)}) and no test file covers it.`,
            nodes: [modId(m.slug)],
            cites: [`${top.rel}:1`],
            prompt: `${PREFIX} write focused tests for ${path} (${modId(m.slug)}), a widely used module no test covers: start with its exported entry points, citing files.`,
          }),
        },
      ];
    });
}

function literals(scan: RepoScan): Ranked[] {
  return codeindex.findLiteralDuplications(scan).duplications.map((d) => {
    const value = JSON.stringify(d.value);
    const sites = [...d.holders, ...d.literals].sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
    const detail =
      d.tier === "competing"
        ? `${plural(new Set(d.holders.map((h) => `${h.file}#${h.holder}`)).size, "constant")} hold ${value} and ${plural(d.literals.length, "site")} inline it, across ${plural(d.files, "file")}.`
        : d.tier === "bypassed"
          ? `A constant holds ${value} but ${plural(d.literals.length, "site")} inline it anyway, across ${plural(d.files, "file")}.`
          : `${value} is inlined ${plural(d.count, "time")} across ${plural(d.files, "file")} with no shared constant.`;
    return {
      score: d.count * 100 + d.files,
      insight: make("literal", codeindex.shortHash(`${d.kind}\0${d.value}`, 12), LITERAL_SEVERITY[d.tier], {
        title: `Repeated literal ${clipText(value, 60)} in ${plural(d.files, "file")}`,
        detail,
        nodes: [...new Set(sites.map((s) => fileId(s.file)))],
        cites: sites.map((s) => `${s.file}:${s.line}`),
        prompt: `${PREFIX} centralise the literal ${clipText(value, 80)} (${plural(d.count, "site")} in ${plural(d.files, "file")}) behind one named constant and update every site, citing files.`,
      }),
    };
  });
}

/**
 * The repository's insights, most severe first: at most INSIGHTS_PER_KIND_MAX
 * per kind and INSIGHTS_MAX overall. Deterministic for a given commit and
 * index. A kind whose analysis cannot run (no git, no history) is absent.
 */
export function insightsOf(repoArg: string, ctx: InsightContext = {}): Insight[] {
  const repo = resolve(repoArg);
  const graph = ctx.graph ?? loadGraph(viewPaths(repo).index);
  if (!graph) throw new Error(`no ultraindex index at ${viewPaths(repo).index}: run \`ultraview build\` first`);
  let scan = ctx.scan;
  const scanOf = () => (scan ??= indexedScan(repo));
  const history = ctx.history ?? repoHistory(repo);
  const kinds: Record<InsightKind, () => Ranked[]> = {
    hotspot: () => hotspots(scanOf(), history),
    "hidden-coupling": () => hiddenCouplings(repo, graph, history),
    cycle: () => cycles(graph),
    "dead-code": () => deadCode(scanOf()),
    "untested-hub": () => untestedHubs(graph),
    literal: () => literals(scanOf()),
  };
  const kept: { insight: Insight; rank: number }[] = [];
  for (const kind of INSIGHT_KINDS) {
    let ranked: Ranked[];
    try {
      ranked = kinds[kind]();
    } catch {
      continue; // one analysis failing never takes the others (or the build) down
    }
    ranked
      .sort((a, b) => SEVERITY_RANK[a.insight.severity] - SEVERITY_RANK[b.insight.severity] || b.score - a.score || cmp(a.insight.id, b.insight.id))
      .slice(0, INSIGHTS_PER_KIND_MAX)
      .forEach((r, rank) => kept.push({ insight: r.insight, rank }));
  }
  return kept
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.insight.severity] - SEVERITY_RANK[b.insight.severity] ||
        KIND_RANK.get(a.insight.kind)! - KIND_RANK.get(b.insight.kind)! ||
        a.rank - b.rank,
    )
    .slice(0, INSIGHTS_MAX)
    .map((k) => k.insight);
}
