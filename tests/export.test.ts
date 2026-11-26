import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { exportBrief, exportMermaid, exportSvg, exportView, pickView } from "../src/export.js";
import { MERMAID_MAX_NODES } from "../src/mermaid.js";
import { builtShop, captureIo } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

async function run(argv: string[]) {
  const cap = captureIo();
  const code = await main(argv, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

describe("export", () => {
  it("draws Mermaid flowcharts per level, lens and flow, byte-stable", async () => {
    const repo = await builtShop(cleanups, { views: true });
    const view = exportView(repo);
    await expect(exportMermaid(view)).toMatchFileSnapshot("./__snapshots__/shop.export-sys.mmd");
    await expect(exportMermaid(view, { level: "cap" })).toMatchFileSnapshot("./__snapshots__/shop.export-cap.mmd");
    await expect(exportMermaid(view, { level: "mod" })).toMatchFileSnapshot("./__snapshots__/shop.export-mod.mmd");
    await expect(exportMermaid(view, { lens: "how-cancel-works" })).toMatchFileSnapshot("./__snapshots__/shop.export-lens.mmd");
    await expect(exportMermaid(view, { flow: "place-order" })).toMatchFileSnapshot("./__snapshots__/shop.export-flow.mmd");
    expect(exportMermaid(exportView(repo))).toBe(exportMermaid(view));
    expect(pickView(view, { level: "mod" }).nodes.length).toBeLessThanOrEqual(MERMAID_MAX_NODES);
    expect(() => pickView(view, { lens: "nope" })).toThrow(/unknown lens "nope"/);
    expect(() => pickView(view, { flow: "nope" })).toThrow(/unknown flow "nope"/);
  });

  it("lays out an SVG and writes a Markdown brief", async () => {
    const repo = await builtShop(cleanups, { views: true });
    const svg = exportSvg(exportView(repo), { level: "mod" });
    await expect(svg).toMatchFileSnapshot("./__snapshots__/shop.export-mod.svg");
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    const brief = exportBrief(exportView(repo, { insights: true }));
    await expect(brief).toMatchFileSnapshot("./__snapshots__/shop.brief.md");
    expect(brief).toContain("## Insights");
    expect(brief).not.toContain(repo);
  });

  it("CLI: one format, --out written atomically, usage errors", async () => {
    const repo = await builtShop(cleanups, { views: true });
    const out = join(repo, "docs", "map.mmd");
    const r = await run(["export", "--mermaid", "--level", "cap", "--out", out, "--repo", repo]);
    expect(r).toMatchObject({ code: 0, out: `wrote      ${out}\n` });
    expect(readFileSync(out, "utf8")).toBe(exportMermaid(exportView(repo), { level: "cap" }));
    expect(existsSync(`${out}.tmp-${process.pid}`)).toBe(false);
    expect((await run(["export", "--md", "--repo", repo])).out).toContain("# Shop");
    expect(JSON.parse((await run(["export", "--svg", "--json", "--repo", repo])).out).format).toBe("svg");
    for (const bad of [[], ["--mermaid", "--md"], ["--md", "--level", "sys"], ["--mermaid", "--level", "file"], ["--mermaid", "--lens", "x", "--flow", "y"]]) {
      expect((await run(["export", ...bad, "--repo", repo])).code).toBe(2);
    }
  });
});
