import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HELP, main, parseArgs } from "../src/cli.js";
import { GITIGNORE_BODY } from "../src/build.js";
import { readStatus } from "../src/status.js";
import { ULTRAINDEX_VERSION } from "../src/engine.js";
import { ULTRAVIEW_VERSION } from "../src/version.js";
import { captureIo, copyFixture } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function shop(): string {
  const { dir, cleanup } = copyFixture("shop-express-prisma");
  cleanups.push(cleanup);
  return dir;
}

async function run(argv: string[]) {
  const cap = captureIo();
  const code = await main(argv, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

describe("cli", () => {
  it("prints help, version, and refuses unknown input", async () => {
    expect((await run([])).out).toBe(HELP);
    expect((await run(["--help"])).out).toBe(HELP);
    expect((await run(["-v"])).out).toBe(`${ULTRAVIEW_VERSION}\n`);
    expect(JSON.parse((await run(["--version", "--json"])).out)).toMatchObject({ ultraview: ULTRAVIEW_VERSION, ultraindex: ULTRAINDEX_VERSION });
    expect((await run(["nope"])).code).toBe(2);
    expect((await run(["build", "--frob"])).code).toBe(2);
    expect((await run(["build", "--repo"])).err).toContain("missing value for --repo");
    expect(parseArgs(["status", "--repo=x", "--json"])).toMatchObject({ command: "status", values: { repo: "x" } });
  });

  it("build writes facts.json and .gitignore, and summarizes for the agent", async () => {
    const repo = shop();
    const r = await run(["build", "--repo", repo, "--no-ast"]);
    expect(r.code).toBe(0);
    const facts = readFileSync(join(repo, ".ultraview", "facts.json"), "utf8");
    await expect(facts).toMatchFileSnapshot("./__snapshots__/shop-express-prisma.facts.json");
    expect(readFileSync(join(repo, ".ultraview", ".gitignore"), "utf8")).toBe(GITIGNORE_BODY);
    expect(GITIGNORE_BODY.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual(["facts.json", "view.json", "index.html"]);
    expect(existsSync(join(repo, ".ultraindex", "graph.json"))).toBe(true);

    expect(r.out).toContain("ultraview build: shop-express-prisma");
    expect(r.out).toMatch(/^ {2}routes +5$/m);
    expect(r.out).toMatch(/^ {2}entities +4$/m);
    expect(r.out).toMatch(/^ {2}entityUses +4$/m);
    expect(r.out).toContain("GET /api/orders  [src/routes/orders.ts:6]");
    expect(r.out).toContain("top modules by PageRank");
    expect(r.out).toContain("next step:");
    expect(r.out.split("\n").length).toBeLessThanOrEqual(150);
  });

  it("build is byte-stable across runs and --json returns the full object", async () => {
    const repo = shop();
    await run(["build", "--repo", repo, "--no-ast"]);
    const first = readFileSync(join(repo, ".ultraview", "facts.json"), "utf8");
    const r = await run(["build", "--repo", repo, "--no-ast", "--json"]);
    expect(readFileSync(join(repo, ".ultraview", "facts.json"), "utf8")).toBe(first);
    const obj = JSON.parse(r.out);
    expect(obj.facts.routes).toHaveLength(5);
    expect(obj.index.files).toBeGreaterThan(5);
    expect(obj.written).toEqual([".ultraview/facts.json", ".ultraview/.gitignore"]);
  });

  it("status routes: no-index -> no-model -> index-stale -> no-model -> ready", async () => {
    const repo = shop();
    expect(readStatus(repo).situation).toBe("no-index");
    const json = JSON.parse((await run(["status", "--repo", repo, "--json"])).out);
    expect(json.situation).toBe("no-index");
    expect(json.worklist[0]).toContain("ultraview build");

    await run(["build", "--repo", repo, "--no-ast"]);
    expect(readStatus(repo).situation).toBe("no-model");

    writeFileSync(join(repo, "src", "server.ts"), `${readFileSync(join(repo, "src", "server.ts"), "utf8")}\n// touched\n`);
    const stale = readStatus(repo);
    expect(stale.situation).toBe("index-stale");
    expect(stale.index.changed).toBe(1);

    await run(["build", "--repo", repo, "--no-ast"]);
    expect(readStatus(repo).situation).toBe("no-model");

    // The model lives under .ultraview/, which the index excludes: writing it
    // must not make the index stale.
    writeFileSync(join(repo, ".ultraview", "model.json"), '{ "schema": 1 }\n');
    const ready = await run(["status", "--repo", repo]);
    expect(ready.out).toContain("situation  ready");
  });

  it("status says index-stale when the index exists but facts.json does not", async () => {
    const repo = shop();
    await run(["build", "--repo", repo, "--no-ast"]);
    const { rmSync } = await import("node:fs");
    rmSync(join(repo, ".ultraview", "facts.json"));
    const s = readStatus(repo);
    expect(s.situation).toBe("index-stale");
    expect(s.reasons).toContain("no .ultraview/facts.json yet");
  });

  it("fails cleanly on a missing repo", async () => {
    const r = await run(["build", "--repo", "/definitely/not/here", "--no-ast"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("repo not found");
  });
});
