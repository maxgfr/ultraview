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
