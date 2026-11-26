import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepoContext } from "../src/extract/index.js";
import type { RepoContext } from "../src/extract/types.js";

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
