// `ultraview render`, as a library call (docs/design.md §7, §8): re-assemble
// the view from the agent files as they stand (src/refresh.ts, the same cheap
// path `serve` takes: no re-indexing, no extractor run), write
// `.ultraview/view.json` when its bytes changed, embed it into the offline
// viewer and write one self-contained `.ultraview/index.html`. A stale index
// is reported, not rebuilt. Never prints, never exits.
//
// The view goes in verbatim (re-serialised compactly) as
// <script type="application/json" id="ultraview-data">; every `<` is written
// `\u003c`, so no string inside it (a summary holding `</script>` or `<!--`)
// can close the element or open a comment — JSON.parse reads it back
// unchanged. The repository's absolute path rides in a separate small blob
// (`ultraview-env`) for "open in editor" links; view.json is never mutated.
// The saved conversations (`.ultraview/conversations/`, valid ones, within a
// byte budget: src/chat.ts `embeddedConversations`) ride in a third one
// (`ultraview-chats`), so `#chat=<id>` opens read-only offline; `serve`
// leaves it empty, its pages read them live.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedConversations } from "./chat.js";
import { indexExists } from "./engine.js";
import { viewPaths } from "./paths.js";
import { freshView, indexStaleness, writeView } from "./refresh.js";

export const DATA_TAG = '<script type="application/json" id="ultraview-data">';
export const ENV_TAG = '<script type="application/json" id="ultraview-env">';
export const CHATS_TAG = '<script type="application/json" id="ultraview-chats">';

export interface RenderOptions {
  repo: string;
  /** Output file (default `<repo>/.ultraview/index.html`). */
  out?: string;
  /** Viewer template (default: the packaged skills/ultraview/assets/viewer.html). */
  template?: string;
}

export interface RenderResult {
  repo: string;
  out: string;
  bytes: number;
  viewBytes: number;
  viewerBytes: number;
  /** view.json was rewritten: agent files changed since it was last written. */
  updated: boolean;
  /** The index no longer matches the source files: the page shows the code as of the last `build`. */
  stale: boolean;
  /** Conversations embedded in the page (read-only offline). */
  chats: number;
}

/** Where the packaged viewer lives, from src/ (tests), scripts/ (repo bundle) or skills/ultraview/scripts/ (installed skill). */
export function viewerTemplatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "../assets/viewer.html"), join(here, "../skills/ultraview/assets/viewer.html")];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`viewer not found (looked in ${candidates.map((c) => relative(process.cwd(), c) || c).join(", ")}): run \`pnpm run build\``);
  return found;
}

/** JSON safe to place inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Replace the body of the first `<script …tag>…</script>` with `body`. */
function fill(html: string, tag: string, body: string): string {
  const start = html.indexOf(tag);
  if (start === -1) throw new Error(`viewer template has no ${tag}`);
  const from = start + tag.length;
  const end = html.indexOf("</script>", from);
  if (end === -1) throw new Error(`viewer template: unterminated ${tag}`);
  return html.slice(0, from) + body + html.slice(end);
}

/** The viewer page for a view (pure); `chats` fill the conversations element when the template has one. */
export function renderHtml(template: string, view: unknown, env: { root?: string }, chats?: readonly unknown[]): string {
  const html = fill(fill(template, DATA_TAG, scriptJson(view)), ENV_TAG, scriptJson(env));
  return chats?.length && html.includes(CHATS_TAG) ? fill(html, CHATS_TAG, scriptJson(chats)) : html;
}

export function renderMap(opts: RenderOptions): RenderResult {
  const repo = resolve(opts.repo);
  const paths = viewPaths(repo);
  const missing = !indexExists(paths.index) ? paths.index : !existsSync(paths.facts) ? paths.facts : undefined;
  if (missing) throw new Error(`no ${relative(process.cwd(), missing) || missing}: run \`ultraview build\` first`);
  const viewText = freshView(repo).text;
  const updated = writeView(paths.view, viewText);
  // The page embeds view.json as written (keys sorted), re-serialised compactly.
  const view: unknown = JSON.parse(viewText);
  let stale = false;
  try {
    stale = indexStaleness(repo).index;
  } catch {
    // an index that cannot be checked is drawn as it is
  }
  const templatePath = opts.template ?? viewerTemplatePath();
  const template = readFileSync(templatePath, "utf8");
  const chats = embeddedConversations(repo);
  const html = renderHtml(template, view, { root: repo }, chats);
  const out = resolve(opts.out ?? paths.html);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, out);
  return {
    repo,
    out,
    bytes: Buffer.byteLength(html),
    viewBytes: Buffer.byteLength(viewText),
    viewerBytes: Buffer.byteLength(template),
    updated,
    stale,
    chats: chats.length,
  };
}

/** The command that opens a file with the OS's default app. */
export function openerFor(platform: NodeJS.Platform, file: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [file] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", '""', file] };
  return { cmd: "xdg-open", args: [file] };
}

/** Start a program detached. Resolves false when it cannot start (not installed); never throws. */
export function spawnDetached(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((done) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => done(false));
      child.once("spawn", () => {
        child.unref();
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

/** Open a file with the OS opener, detached. Resolves false when there is no opener; never throws. */
export function openFile(file: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const { cmd, args } = openerFor(platform, file);
  return spawnDetached(cmd, args);
}
