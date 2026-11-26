import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { stableJson } from "../src/json.js";
import { FIXTURES } from "./helpers.js";

const SHOP = join(FIXTURES, "shop-express-prisma");

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(relative(root, p));
  }
  return out;
}

const read = (abs: string) => readFileSync(abs, "utf8");

describe("runExtractors on the shop fixture", () => {
  const files = walk(SHOP);

  it("finds the real routes, under their mount prefix, and nothing else", () => {
    const facts = runExtractors(SHOP, files, read);
    expect(facts.routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line}`)).toEqual([
      "GET /api/orders src/routes/orders.ts:6",
      "POST /api/orders src/routes/orders.ts:10",
      "GET /api/orders/:id src/routes/orders.ts:16",
      "DELETE /api/orders/:id src/routes/orders.ts:19",
      "GET /health src/server.ts:9",
    ]);
  });

  it("finds the four models and their relations, not the commented one or the enum", () => {
    const facts = runExtractors(SHOP, files, read);
    expect(facts.entities.map((e) => `${e.name}:${e.line} -> ${e.fields.flatMap((f) => (f.relation ? [f.relation] : [])).join(",")}`)).toEqual([
      "User:19 -> Order",
      "Product:27 -> OrderItem",
      "Order:36 -> User,OrderItem",
      "OrderItem:47 -> Order,Product",
    ]);
  });

  it("finds the service's reads and writes, not the commented or quoted ones", () => {
    const facts = runExtractors(SHOP, files, read);
    expect(facts.entityUses).toEqual([
      { entity: "Order", file: "src/services/orders.ts", line: 9, op: "read" },
      { entity: "Product", file: "src/services/orders.ts", line: 14, op: "read" },
      { entity: "Order", file: "src/services/orders.ts", line: 16, op: "write" },
      { entity: "Order", file: "src/services/orders.ts", line: 26, op: "write" },
    ]);
  });

  it("is deterministic: two runs, and any file order, give byte-identical facts", () => {
    const a = stableJson(runExtractors(SHOP, files, read));
    const b = stableJson(runExtractors(SHOP, [...files].reverse(), read));
    expect(b).toBe(a);
    expect(stableJson(runExtractors(SHOP, files, read))).toBe(a);
  });

  it("reports an extractor that throws and keeps going", () => {
    const failures: string[] = [];
    const facts = runExtractors(SHOP, files, read, {
      extractors: [
        {
          id: "boom",
          applies: (i) => i.rel === "src/server.ts",
          extract: () => {
            throw new Error("bad input");
          },
        },
      ],
      onError: (f) => failures.push(`${f.extractor} ${f.file} ${f.message}`),
    });
    expect(failures).toEqual(["boom src/server.ts bad input"]);
    expect(facts.routes).toEqual([]);
  });
});
