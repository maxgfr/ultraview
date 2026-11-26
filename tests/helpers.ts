import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildMap } from "../src/build.js";
import { createRepoContext, runExtractors } from "../src/extract/index.js";
import type { RepoContext } from "../src/extract/types.js";
import { saveFlow, saveLens } from "../src/save.js";

export const FIXTURES = join(import.meta.dirname, "fixtures");

/** A throwaway copy of a fixture, so builds never write into the source tree. */
export function copyFixture(name: string): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ultraview-test-"));
  const dir = join(root, name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A repo context from an in-memory file map. */
export function memoryContext(files: Record<string, string>): RepoContext {
  return createRepoContext(Object.keys(files), (rel) => files[rel]);
}

/** Capture a CLI run's output. */
export function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** Agent-authored files for the fixtures (models, flows, lenses), copied into temp repos by the tests. */
export const MODELS = join(import.meta.dirname, "fixtures-models");

export function readModelFile(name: string): any {
  return JSON.parse(readFileSync(join(MODELS, name), "utf8"));
}

/** Write a JSON file under `<repo>/.ultraview/`. */
export function writeView(repo: string, rel: string, value: unknown): void {
  const abs = join(repo, ".ultraview", rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** Append a line to a fixture source file (makes the index and every lens citing it stale). */
export function touch(repo: string, rel: string): void {
  const abs = join(repo, rel);
  writeFileSync(abs, `${readFileSync(abs, "utf8")}\n// touched\n`);
}

export interface ShopOptions {
  /** model.json to write before building: true = the shop model, an object = that model, false = none. */
  model?: boolean | object;
  /** Save the shop lens / flow (stamping sources) after the build. */
  views?: boolean;
}

/**
 * A built temp copy of the shop fixture, optionally with the test model, lens
 * and flow. Registers its cleanup in `cleanups`.
 */
export async function builtShop(cleanups: (() => void)[], opts: ShopOptions = {}): Promise<string> {
  const { dir, cleanup } = copyFixture("shop-express-prisma");
  cleanups.push(cleanup);
  const model = opts.model ?? true;
  if (model) writeView(dir, "model.json", model === true ? readModelFile("shop.model.json") : model);
  await buildMap({ repo: dir, ast: false, builtAt: "2026-01-01T00:00:00.000Z" });
  if (opts.views) {
    const lens = saveLens(dir, readModelFile("shop.lens.json"));
    const flow = saveFlow(dir, readModelFile("shop.flow.json"));
    if (!lens.ok || !flow.ok) throw new Error(`fixture views not saved: ${JSON.stringify([lens.errors, flow.errors])}`);
  }
  return dir;
}

/** Run every extractor and linker over an in-memory repo (keys are repo-relative paths). */
export function factsOfFiles(files: Record<string, string>) {
  return runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
}

// --- git repos for the change / history tests --------------------------------

let gitClock = Date.parse("2026-01-01T00:00:00Z");

/**
 * Run git in `dir`, isolated from the machine's git config (no global or
 * system file: hermetic identity, branch name and dates), so commits made in
 * throwaway test repos are byte-identical everywhere.
 */
export function git(dir: string, args: string[], opts: { date?: string } = {}): string {
  const date = opts.date ?? new Date((gitClock += 60_000)).toISOString();
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(dir, ".git-test-config-absent"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

/** `git init` + one commit of everything in `dir` (`.ultraindex/` ignored). */
export function gitInit(dir: string, date = "2026-01-01T00:00:00Z"): void {
  writeFileSync(join(dir, ".gitignore"), ".ultraindex/\n");
  git(dir, ["init", "-q", "-b", "main"], { date });
  git(dir, ["add", "-A"], { date });
  git(dir, ["commit", "-q", "-m", "init"], { date });
}

/**
 * A built shop fixture under git: the model and `.ultraview/.gitignore`
 * committed with the sources, the index fresh. Edits after this are "the change".
 */
export async function gitShop(cleanups: (() => void)[]): Promise<string> {
  const { dir, cleanup } = copyFixture("shop-express-prisma");
  cleanups.push(cleanup);
  writeFileSync(join(dir, ".gitignore"), ".ultraindex/\n");
  writeView(dir, "model.json", readModelFile("shop.model.json"));
  await buildMap({ repo: dir, ast: false, builtAt: "2026-01-01T00:00:00.000Z" });
  gitInit(dir);
  return dir;
}
