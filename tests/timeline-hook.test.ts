import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { stableLine } from "../src/json.js";
import { HOOK_MARKER, hookCommand, installHook, LOCAL_SETTINGS_FILE, lineDiff, SHARED_SETTINGS_FILE, uninstallHook } from "../src/hook.js";
import { addTimelineEntry, appendTimeline, itemsFromFlags } from "../src/timeline.js";
import { builtShop, captureIo, copyFixture } from "./helpers.js";

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

const CITED = "Cancelling an order sets its status back to pending. [src/services/orders.ts:26]";
const timelineOf = (repo: string) => join(repo, ".ultraview/timeline.jsonl");

describe("timeline add", () => {
  it("appends one stable-JSON line per entry, never rewriting the file", async () => {
    const repo = await builtShop(cleanups);
    const first = await run([
      "timeline",
      "add",
      "--repo",
      repo,
      "--title",
      "Explain cancel",
      "--request",
      "why does cancel not delete?",
      "--summary",
      CITED,
      "--ref",
      "route:DELETE /api/orders/:id",
      "--note",
      "soft cancel",
      "--ref",
      "sym:src/services/orders.ts#cancelOrder",
      "--change",
      "changed",
    ]);
    expect(first).toMatchObject({ code: 0, err: "" });
    const one = readFileSync(timelineOf(repo), "utf8");
    expect(one.endsWith("\n")).toBe(true);
    const entry = JSON.parse(one);
    expect(entry).toMatchObject({
      source: "agent",
      title: "Explain cancel",
      request: "why does cancel not delete?",
      items: [
        { ref: "route:DELETE /api/orders/:id", change: "changed", note: "soft cancel" },
        { ref: "sym:src/services/orders.ts#cancelOrder", change: "changed" },
      ],
    });
    // One line, keys sorted, no indentation.
    expect(one).toBe(stableLine(entry));

    const second = await run([
      "timeline",
      "add",
      "--repo",
      repo,
      "--source",
      "pr",
      "--title",
      "Drop the routes",
      "--summary",
      CITED,
      "--items",
      '[{"ref":"route:GET /api/gone","change":"removed"}]',
    ]);
    expect(second.code).toBe(0);
    const two = readFileSync(timelineOf(repo), "utf8");
    expect(two.startsWith(one)).toBe(true);
    expect(two.trimEnd().split("\n")).toHaveLength(2);
  });

  it("refuses an entry that fails validation, writing nothing", async () => {
    const repo = await builtShop(cleanups);
    const base = ["timeline", "add", "--repo", repo, "--title", "T"];
    const uncited = await run([...base, "--summary", "Nothing cites this."]);
    expect(uncited.code).toBe(1);
    expect(uncited.err).toContain("uncited sentence");
    const dead = await run([...base, "--summary", "A dead citation. [src/nope.ts:1]"]);
    expect(dead.err).toContain("dead citation");
    const unknown = await run([...base, "--summary", CITED, "--ref", "route:GET /nope"]);
    expect(unknown.err).toContain('unknown node "route:GET /nope"');
    const badKind = await run([...base, "--summary", CITED, "--ref", "file:src/db.ts", "--change", "added"]);
    expect(badKind.err).toContain('"added" is not one of new, changed, removed');
    const orphan = await run([...base, "--summary", CITED, "--note", "no ref"]);
    expect(orphan.err).toContain("--note must follow a --ref");
    const badJson = await run([...base, "--summary", CITED, "--items", "{"]);
    expect(badJson.err).toContain("invalid JSON");
    expect((await run([...base, "--summary", CITED, "--source", "bot"])).code).toBe(2);
    expect((await run(["timeline", "add", "--repo", repo, "--title", "T"])).code).toBe(2);
    expect((await run(["timeline", "list", "--repo", repo])).code).toBe(2);
    expect(existsSync(timelineOf(repo))).toBe(false);
  });

  it("completes a missing final newline instead of rewriting", async () => {
    const repo = await builtShop(cleanups);
    const r = addTimelineEntry(repo, { title: "A", summary: CITED }, new Date("2026-01-02T00:00:00.000Z"));
    expect(r.ok).toBe(true);
    const text = readFileSync(timelineOf(repo), "utf8").trimEnd();
    writeFileSync(timelineOf(repo), text);
    expect(appendTimeline(repo, { ...r.entry!, title: "B" })).toEqual([]);
    expect(readFileSync(timelineOf(repo), "utf8")).toBe(`${text}\n${text.replace('"title":"A"', '"title":"B"')}\n`);
    expect(appendTimeline(repo, { ...r.entry!, source: "bot" as never })[0]!.message).toContain("is not one of");
    expect(
      itemsFromFlags([
        ["ref", "a:b"],
        ["change", "new"],
      ]).items,
    ).toEqual([{ ref: "a:b", change: "new" }]);
  });
});

const OTHER = {
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
  model: "x",
};

function repoWithSettings(text?: string, file: string = LOCAL_SETTINGS_FILE): string {
  const { dir, cleanup } = copyFixture("shop-express-prisma");
  cleanups.push(cleanup);
  if (text !== undefined) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const settingsOf = (repo: string, file: string = LOCAL_SETTINGS_FILE) => readFileSync(join(repo, file), "utf8");
const SCRIPT = "/opt/ultra view/scripts/ultraview.mjs";

describe("hook install / uninstall", () => {
  it("adds a Claude Code Stop hook next to the others and removes exactly it, in either settings file", () => {
    for (const [file, shared] of [
      [LOCAL_SETTINGS_FILE, false],
      [SHARED_SETTINGS_FILE, true],
    ] as const)
      for (const original of [
        `${JSON.stringify(OTHER, null, 2)}\n`,
        JSON.stringify(OTHER, null, "\t"),
        '{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}\n',
      ]) {
        const repo = repoWithSettings(original, file);
        const r = installHook(repo, SCRIPT, { shared });
        expect(r).toMatchObject({ ok: true, action: "installed", file, files: [file] });
        expect(r.warning !== undefined).toBe(shared);
        const after = settingsOf(repo, file);
        const parsed = JSON.parse(after);
        // Every other key and hook is still there, untouched.
        expect(parsed.model).toBe("x");
        expect(parsed.hooks.Stop[0]).toEqual({ hooks: [{ type: "command", command: "say done" }] });
        expect(parsed.hooks.Stop[1]).toEqual({ hooks: [{ type: "command", command: hookCommand(SCRIPT), timeout: 30 }] });
        // Byte-preserving: the original is the new text minus one inserted span.
        const at = [...original].findIndex((ch, i) => ch !== after[i]);
        const inserted = after.length - original.length;
        expect(after.slice(0, at) + after.slice(at + inserted)).toBe(original);
        // Idempotent, and the inverse is exact.
        expect(installHook(repo, SCRIPT, { shared }).action).toBe("unchanged");
        expect(uninstallHook(repo)).toMatchObject({ ok: true, action: "removed", files: [file] });
        expect(settingsOf(repo, file)).toBe(original);
        expect(uninstallHook(repo).action).toBe("absent");
      }
  });

  it("defaults to the personal settings.local.json; --shared warns; uninstall clears both", async () => {
    const shared = `${JSON.stringify(OTHER, null, 2)}\n`;
    const repo = repoWithSettings(shared, SHARED_SETTINGS_FILE);
    const local = await run(["hook", "install", "--repo", repo]);
    expect(local).toMatchObject({ code: 0, err: "" });
    expect(local.out).toContain("installed: .claude/settings.local.json");
    expect(settingsOf(repo, SHARED_SETTINGS_FILE)).toBe(shared);
    expect(settingsOf(repo)).toContain(HOOK_MARKER);

    const team = await run(["hook", "install", "--shared", "--repo", repo]);
    expect(team.code).toBe(0);
    expect(team.out).toContain("installed: .claude/settings.json");
    expect(team.err).toContain("ultraview: warning: .claude/settings.json is shared with everyone who clones the repo");
    expect(team.err).toContain("absolute path specific to this machine");

    const dry = await run(["hook", "uninstall", "--dry-run", "--repo", repo]);
    expect(dry.out).toContain("(dry run) would be removed: .claude/settings.local.json, .claude/settings.json");
    expect(settingsOf(repo, SHARED_SETTINGS_FILE)).toContain(HOOK_MARKER);
    const gone = uninstallHook(repo);
    expect(gone).toMatchObject({ action: "removed", files: [LOCAL_SETTINGS_FILE, SHARED_SETTINGS_FILE] });
    expect(settingsOf(repo, SHARED_SETTINGS_FILE)).toBe(shared);
    expect(JSON.parse(settingsOf(repo))).toEqual({});
  });

  it("creates the file when absent, updates a moved script, leaves a shared group's other hooks", () => {
    const repo = repoWithSettings();
    expect(installHook(repo, SCRIPT).action).toBe("installed");
    expect(JSON.parse(settingsOf(repo))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: hookCommand(SCRIPT), timeout: 30 }] }] } });
    const moved = installHook(repo, "/elsewhere/ultraview.mjs");
    expect(moved.action).toBe("updated");
    expect(settingsOf(repo)).toContain("/elsewhere/ultraview.mjs");
    expect(settingsOf(repo)).not.toContain(SCRIPT);
    expect(uninstallHook(repo).action).toBe("removed");
    expect(JSON.parse(settingsOf(repo))).toEqual({});

    const shared = repoWithSettings(
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: "command", command: "say done" },
                  { type: "command", command: hookCommand(SCRIPT) },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(uninstallHook(shared).action).toBe("removed");
    expect(JSON.parse(settingsOf(shared))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
  });

  it("--dry-run shows the diff and writes nothing; bad settings and agents are refused", async () => {
    const original = `${JSON.stringify(OTHER, null, 2)}\n`;
    const repo = repoWithSettings(original);
    const dry = await run(["hook", "install", "--dry-run", "--repo", repo]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("(dry run) would be installed: .claude/settings.local.json");
    expect(dry.out).toContain("--- a/.claude/settings.local.json");
    expect(dry.out).toContain(`+${" ".repeat(12)}"command": `);
    expect(dry.out).toContain(HOOK_MARKER);
    expect(settingsOf(repo)).toBe(original);

    const broken = repoWithSettings("{ not json");
    const r = installHook(broken, SCRIPT);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("not valid JSON");
    expect(settingsOf(broken)).toBe("{ not json");
    expect(installHook(repoWithSettings('{"hooks":[]}'), SCRIPT).errors[0]).toContain('"hooks" is not an object');
    expect(installHook(repo, SCRIPT, { agent: "codex" }).errors[0]).toContain('unsupported agent "codex"');
    expect((await run(["hook", "remove", "--repo", repo])).code).toBe(2);
  });

  it("quotes the script path for the shell and runs worktree recording silently", () => {
    expect(hookCommand("/a b/it's/ultraview.mjs")).toBe(
      `node '/a b/it'\\''s/ultraview.mjs' diff --worktree --record --quiet --source agent --hook --repo "$CLAUDE_PROJECT_DIR"`,
    );
    expect(lineDiff("a\nb\n", "a\nc\nb\n", "f")).toBe("--- a/f\n+++ b/f\n a\n+c\n b\n");
    expect(lineDiff("x\n", "x\n", "f")).toBe("");
  });
});
