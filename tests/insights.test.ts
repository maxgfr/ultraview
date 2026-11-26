import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap } from "../src/build.js";
import { main } from "../src/cli.js";
import { httpsRemote } from "../src/git.js";
import { CHURN_WINDOW_MONTHS, INSIGHTS_PER_KIND_MAX, insightsOf, repoHistory, windowStart } from "../src/insights.js";
import { stableJson } from "../src/json.js";
import type { ViewModel } from "../src/model/types.js";
import { captureIo, git, gitInit } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/**
 * A synthetic repo with one of each: an import cycle (src/a <-> src/b), a hub
 * three modules import and no test covers (src/hub), twelve files with an
 * unused export each (src/dead), and a URL inlined in three files.
 */
function synthRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ultraview-insights-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "synth");
  const files: Record<string, string> = {
    "package.json": '{"name":"synth","version":"1.0.0"}\n',
    "src/a/index.ts": 'import { b } from "../b/index.js";\n\nexport function a() {\n  return b() + 1;\n}\n',
    "src/b/index.ts": 'import { a } from "../a/index.js";\n\nexport function b() {\n  return 1;\n}\n\nexport function useA() {\n  return a();\n}\n',
    "src/hub/util.ts": "export function shared(x: number) {\n  return x * 2;\n}\n",
  };
  const imports = ['import { a } from "./a/index.js";', 'import { useA } from "./b/index.js";'];
  const calls = ["a();", "useA();"];
  for (const m of ["c", "d", "e"]) {
    files[`src/${m}/mod.ts`] =
      `import { shared } from "../hub/util.js";\n\nexport function run_${m}() {\n  return fetch("https://api.example.com/v1/orders").then(() => shared(1));\n}\n`;
    imports.push(`import { run_${m} } from "./${m}/mod.js";`);
    calls.push(`run_${m}();`);
  }
  for (let i = 0; i < 12; i++) {
    files[`src/dead/lib${i}.ts`] = `export function used${i}() {\n  return ${i};\n}\n\nexport function unused${i}() {\n  return ${i};\n}\n`;
    imports.push(`import { used${i} } from "./dead/lib${i}.js";`);
    calls.push(`used${i}();`);
  }
  files["src/main.ts"] = `${imports.join("\n")}\n\n${calls.join("\n")}\n`;
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const append = (dir: string, rel: string, line: string) => writeFileSync(join(dir, rel), `${readFileSync(join(dir, rel), "utf8")}${line}\n`);

describe("insights", () => {
  it("finds cycles, untested hubs, dead code and repeated literals, capped and deterministic", async () => {
    const repo = synthRepo();
    await buildMap({ repo, ast: false, builtAt: "2026-01-01T00:00:00.000Z" });
    const insights = insightsOf(repo);
    const kinds = new Map<string, number>();
    for (const i of insights) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
    expect(Object.fromEntries(kinds)).toEqual({ "dead-code": INSIGHTS_PER_KIND_MAX, cycle: 1, "untested-hub": 1, literal: 1 });

    expect(insights.find((i) => i.kind === "cycle")).toMatchObject({
      id: "cycle:src-a>src-b",
      severity: "low",
      nodes: ["mod:src-a", "mod:src-b"],
      cites: ["src/a/index.ts:1", "src/b/index.ts:1"],
      prompt: "Using ultraview and ultraindex, propose a safe refactor to break the import cycle between src/a, src/b (mod:src-a, mod:src-b), citing files.",
    });
    expect(insights.find((i) => i.kind === "untested-hub")).toMatchObject({ id: "untested-hub:src-hub", nodes: ["mod:src-hub"], cites: ["src/hub/util.ts:1"] });
    expect(insights.find((i) => i.id === "dead-code:src/dead/lib0.ts")).toMatchObject({
      severity: "medium",
      nodes: ["file:src/dead/lib0.ts", "sym:src/dead/lib0.ts#unused0"],
      cites: ["src/dead/lib0.ts:5"],
    });
    const literal = insights.find((i) => i.kind === "literal")!;
    expect(literal).toMatchObject({ severity: "low", cites: ["src/c/mod.ts:4", "src/d/mod.ts:4", "src/e/mod.ts:4"] });
    expect(literal.title).toBe('Repeated literal "https://api.example.com/v1/orders" in 3 files');
    for (const i of insights) {
      expect(i.prompt.startsWith("Using ultraview and ultraindex,")).toBe(true);
      expect(i.cites.length).toBeGreaterThan(0);
    }
    // Most severe first, then by kind.
    expect(insights.map((i) => i.severity)).toEqual(
      [...insights.map((i) => i.severity)].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)),
    );
    expect(stableJson(insightsOf(repo))).toBe(stableJson(insights));

    // The view carries them; the CLI lists them.
    const view = JSON.parse(readFileSync(join(repo, ".ultraview/view.json"), "utf8")) as ViewModel;
    expect(view.insights).toEqual(insights);
    const cap = captureIo();
    expect(await main(["insights", "--repo", repo], cap.io)).toBe(0);
    expect(cap.out()).toContain("[low] cycle  Import cycle: src/a → src/b → src/a");
    expect(cap.out()).toContain("prompt: Using ultraview and ultraindex, write focused tests for src/hub");
  });

  it("reads churn, hotspots and hidden coupling from a window ending at HEAD's commit date", async () => {
    const repo = synthRepo();
    gitInit(repo, "2025-01-01T00:00:00Z"); // outside the window: counts for nothing
    for (let day = 1; day <= 6; day++) {
      const date = `2026-01-0${day}T12:00:00Z`;
      append(repo, "src/a/index.ts", `// change ${day}`);
      append(repo, "src/e/mod.ts", `// change ${day}`);
      git(repo, ["commit", "-q", "-am", `change ${day}`], { date });
    }
    git(repo, ["remote", "add", "origin", "https://someone:secret@github.com/acme/synth.git"]);
    await buildMap({ repo, ast: false, builtAt: "2026-01-01T00:00:00.000Z" });

    const history = repoHistory(repo);
    expect(history).toMatchObject({ ok: true, since: windowStart("2026-01-06T12:00:00Z"), commits: 6 });
    expect(history.since).toBe("2025-07-06");
    expect(CHURN_WINDOW_MONTHS).toBe(6);
    const view = JSON.parse(readFileSync(join(repo, ".ultraview/view.json"), "utf8")) as ViewModel;
    const metrics = (id: string) => view.nodes.find((n) => n.id === id)!.metrics;
    expect(metrics("file:src/a/index.ts").churn).toBe(6);
    expect(metrics("file:src/d/mod.ts").churn).toBe(0);
    expect(metrics("mod:src-a").churn).toBe(6);
    expect(metrics("sys:app").churn).toBe(12);
    expect(view.repo.remote).toBe("https://github.com/acme/synth");
    expect(JSON.stringify(view)).not.toContain("secret");

    const insights = insightsOf(repo);
    expect(insights.filter((i) => i.kind === "hotspot").map((i) => i.id)).toEqual(["hotspot:src/a/index.ts", "hotspot:src/e/mod.ts"]);
    expect(insights.find((i) => i.kind === "hidden-coupling")).toMatchObject({
      id: "hidden-coupling:src/a/index.ts|src/e/mod.ts",
      nodes: ["file:src/a/index.ts", "file:src/e/mod.ts"],
    });
    expect(insights.find((i) => i.kind === "hidden-coupling")!.detail).toContain("Changed together in 6 of 6 commits since 2025-07-06");
  });

  it("leaves churn at 0 and history kinds out outside git", async () => {
    const repo = synthRepo();
    await buildMap({ repo, ast: false });
    expect(repoHistory(repo)).toEqual({ ok: false, churn: new Map(), commits: 0 });
    expect(insightsOf(repo).some((i) => i.kind === "hotspot" || i.kind === "hidden-coupling")).toBe(false);
  });
});

describe("httpsRemote", () => {
  it("turns remotes into https URLs with credentials stripped", () => {
    expect(httpsRemote("git@github.com:o/r.git")).toBe("https://github.com/o/r");
    expect(httpsRemote("ssh://git@gitlab.example.com:2222/group/sub/r.git")).toBe("https://gitlab.example.com/group/sub/r");
    expect(httpsRemote("https://user:token@GitHub.com/o/r.git/\n")).toBe("https://github.com/o/r");
    expect(httpsRemote("http://host/o/r")).toBe("https://host/o/r");
    expect(httpsRemote("/srv/git/r.git")).toBeUndefined();
    expect(httpsRemote("file:///srv/git/r.git")).toBeUndefined();
    expect(httpsRemote("C:\\repos\\r")).toBeUndefined();
  });
});
