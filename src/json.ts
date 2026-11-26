import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Byte-stable JSON for every generated file: object keys sorted recursively,
// two-space indent, `\n` line endings, trailing newline. Two runs over the same
// input must produce the same bytes, so a diff of a generated file is a diff of
// its meaning, never of key order.

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

/** One line of byte-stable JSON (sorted keys, no indent) with a trailing newline: a JSONL record. */
export function stableLine(value: unknown): string {
  return `${JSON.stringify(sortValue(value))}\n`;
}

/** Write via a temp file + rename, so a reader never sees half a file. */
export function writeFileAtomic(path: string, text: string): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
}
