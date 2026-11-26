import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap } from "../src/build.js";
import { main } from "../src/cli.js";
import { saveLens } from "../src/save.js";
import { carriedOver } from "../src/refresh.js";
import { DATA_TAG, ENV_TAG, openerFor, renderHtml, renderMap, scriptJson, spawnDetached, viewerTemplatePath } from "../src/render.js";
import { builtShop, captureIo, gitShop, readModelFile, touch } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const TEMPLATE = `<!doctype html><body>${DATA_TAG}null</script>${ENV_TAG}{}</script><script>/* app */</script></body>`;

/** The JSON inside the element `tag` opens, read back the way the browser does (textContent → JSON.parse). */
function embedded(html: string, tag: string): unknown {
  const start = html.indexOf(tag) + tag.length;
  return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ultraview-render-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("render", () => {
  it("embeds the view and the repo root as JSON that round-trips", () => {
    const view = { schema: 1, nodes: [{ id: "cap:x", label: "Ünïcode ✓ \u2028 line" }], app: { name: "A & B" } };
    const html = renderHtml(TEMPLATE, view, { root: "/repo" });
    expect(embedded(html, DATA_TAG)).toEqual(view);
    expect(embedded(html, ENV_TAG)).toEqual({ root: "/repo" });
    expect(html.endsWith("<script>/* app */</script></body>")).toBe(true);
  });

  it("a </script> or <!-- inside the data cannot break out of the element", () => {
    const evil = { summary: '</script><script>alert(1)</script><!-- </SCRIPT> <script type="x">' };
    const html = renderHtml(TEMPLATE, evil, {});
    const body = html.slice(html.indexOf(DATA_TAG) + DATA_TAG.length, html.indexOf("</script>", html.indexOf(DATA_TAG)));
    expect(body).not.toMatch(/<\/?script|<!--/i);
    expect(embedded(html, DATA_TAG)).toEqual(evil);
    expect(scriptJson("<")).toBe('"\\u003c"');
    // only the template's own three closing tags remain
    expect(html.match(/<\/script>/g)).toHaveLength(3);
  });

  it("refuses a template without the data element", () => {
    expect(() => renderHtml("<html></html>", {}, {})).toThrow(/no <script type="application\/json" id="ultraview-data">/);
  });

  it("writes .ultraview/index.html from the shop build, byte-stable across runs", async () => {
    const repo = await builtShop(cleanups, { views: true });
    const first = renderMap({ repo });
    expect(first.out).toBe(join(repo, ".ultraview", "index.html"));
    const html = readFileSync(first.out, "utf8");
    const view = JSON.parse(readFileSync(join(repo, ".ultraview", "view.json"), "utf8"));
    expect(embedded(html, DATA_TAG)).toEqual(view);
    expect(embedded(html, ENV_TAG)).toEqual({ root: repo });
    expect(html).toContain('id="ultraview-elk"');
    expect(first.bytes).toBe(Buffer.byteLength(html));
    renderMap({ repo });
    expect(readFileSync(first.out, "utf8")).toBe(html);
    // the packaged viewer is the template, untouched apart from the two blobs
    const template = readFileSync(viewerTemplatePath(), "utf8");
    expect(html.length - template.length).toBe(scriptJson(view).length - "null".length + scriptJson({ root: repo }).length - "{}".length);
  });

  it("--out writes elsewhere; a missing index or facts.json says to build first", async () => {
    const dir = tempDir();
    const out = join(dir, "nested", "map.html");
    expect(() => renderMap({ repo: dir })).toThrow(/run `ultraview build` first/);
    const repo = await builtShop(cleanups);
    const r = renderMap({ repo, out });
    expect(r.out).toBe(out);
    expect(existsSync(out)).toBe(true);
    // a broken or missing view.json is re-assembled, not refused
    writeFileSync(join(repo, ".ultraview", "view.json"), "{ nope");
    expect(renderMap({ repo }).updated).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, ".ultraview", "view.json"), "utf8")).schema).toBe(1);
    rmSync(join(repo, ".ultraview", "facts.json"));
    expect(() => renderMap({ repo })).toThrow(/no .*facts\.json: run `ultraview build` first/);
  });

  it("draws a lens saved after the build, without building again", async () => {
    const repo = await builtShop(cleanups);
    const viewFile = join(repo, ".ultraview", "view.json");
    const lens = readModelFile("shop.lens.json");
    expect(JSON.parse(readFileSync(viewFile, "utf8")).lenses).toEqual([]);
    expect(saveLens(repo, lens).ok).toBe(true);
    const r = renderMap({ repo });
    expect(r).toMatchObject({ updated: true, stale: false });
    const html = readFileSync(r.out, "utf8");
    const embeddedView = embedded(html, DATA_TAG) as { lenses: { id: string; answer: string }[] };
    expect(embeddedView.lenses.map((l) => l.id)).toEqual([lens.id]);
    expect(embeddedView.lenses[0]!.answer).toBe(lens.answer);
    // view.json is what the page embeds, written once
    expect(JSON.parse(readFileSync(viewFile, "utf8"))).toEqual(embeddedView);
    const viewText = readFileSync(viewFile, "utf8");
    const again = renderMap({ repo });
    expect(again.updated).toBe(false);
    expect(readFileSync(viewFile, "utf8")).toBe(viewText);
    expect(readFileSync(again.out, "utf8")).toBe(html);
  });

  it("right after build, render rewrites nothing: churn and insights are carried over", async () => {
    const repo = await gitShop(cleanups);
    await buildMap({ repo, ast: false, builtAt: "2026-01-01T00:00:00.000Z" });
    const viewFile = join(repo, ".ultraview", "view.json");
    const built = readFileSync(viewFile, "utf8");
    const carried = carriedOver(built);
    expect(carried.churn?.size).toBeGreaterThan(0);
    expect(carried.insights?.length).toBeGreaterThan(0);
    expect(renderMap({ repo }).updated).toBe(false);
    expect(readFileSync(viewFile, "utf8")).toBe(built);
    expect(carriedOver(undefined)).toEqual({});
    expect(carriedOver("{ nope")).toEqual({});
    expect(carriedOver('{"schema":0,"nodes":[]}')).toEqual({});
  });

  it("a stale index is noted (text and --json) but the page is still drawn", async () => {
    const repo = await builtShop(cleanups);
    expect(renderMap({ repo }).stale).toBe(false);
    const fresh = captureIo();
    expect(await main(["render", "--repo", repo], fresh.io)).toBe(0);
    expect(fresh.out()).not.toContain("stale");
    touch(repo, "src/db.ts");
    const cap = captureIo();
    expect(await main(["render", "--repo", repo], cap.io)).toBe(0);
    expect(cap.out()).toMatch(/^rendered .*\nnote {7}the index is stale: .*run `ultraview build`.*\n/);
    const j = captureIo();
    expect(await main(["render", "--repo", repo, "--json"], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject({ stale: true });
    expect(existsSync(join(repo, ".ultraview", "index.html"))).toBe(true);
  });

  it("CLI: render prints where it wrote, --json returns the result, missing view exits 1", async () => {
    const repo = await builtShop(cleanups);
    const cap = captureIo();
    expect(await main(["render", "--repo", repo], cap.io)).toBe(0);
    expect(cap.out()).toMatch(/^rendered {3}.*index\.html \(\d+ KB: view \d+ KB \+ viewer \d+ KB\)\n/);
    const j = captureIo();
    expect(await main(["render", "--repo", repo, "--json", "--out", join(repo, "x.html")], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject({ out: join(repo, "x.html"), repo });
    const empty = captureIo();
    expect(await main(["render", "--repo", tempDir()], empty.io)).toBe(1);
    expect(empty.err()).toContain("run `ultraview build` first");
    expect(await main(["render", "extra"], captureIo().io)).toBe(2);
  });

  it("opens with the OS opener and never fails without one", async () => {
    expect(openerFor("darwin", "/a b.html")).toEqual({ cmd: "open", args: ["/a b.html"] });
    expect(openerFor("linux", "/x.html")).toEqual({ cmd: "xdg-open", args: ["/x.html"] });
    expect(openerFor("win32", "C:\\x.html").cmd).toBe("cmd");
    // an opener that does not exist on this machine resolves false instead of throwing
    expect(await spawnDetached("ultraview-no-such-opener", ["/x.html"])).toBe(false);
  });
});
