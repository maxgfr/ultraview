// Prisma: entities from `*.prisma` schema files, and entity uses from Prisma
// Client calls (`prisma.order.create(…)`).
//
// Schema: every `model Name { … }` is an entity; each field line
// (`name Type modifiers @attributes`) is a field. Block attributes (`@@id`,
// `@@index`, …) are skipped. Which fields are relations is decided by the
// `prisma-relations` linker once every schema file is read, because Prisma's
// multi-file schemas put related models in different files.
//
// Client: `<client>.<model>.<operation>(` with a known operation name, in a
// workspace that depends on `@prisma/client` (or `prisma`). The accessor is
// the model name with a lower-case first letter; the linker maps it back to
// the declared model.

import { isJsLike } from "./js.js";
import { lineIndex, maskSource } from "./mask.js";
import type { EntityFact, EntityField, EntityUseFact, ExtractInput, ExtractOutput, Extractor, Facts, Linker, RepoContext } from "./types.js";

const ORM = "prisma";

const READ_OPS = ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"];
const WRITE_OPS = ["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"];
const OP_KIND = new Map<string, "read" | "write">([...READ_OPS.map((o) => [o, "read"] as const), ...WRITE_OPS.map((o) => [o, "write"] as const)]);

/** Prisma's scalar types: never relations. */
const SCALARS = new Set(["String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes", "Unsupported"]);

/** The base type of a field type: `OrderItem[]` / `User?` → `OrderItem` / `User`. */
export function baseType(type: string): string {
  return type.replace(/(?:\[\]|\?)+$/, "").replace(/\(.*$/, "");
}

function extractSchema(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text);
  const lineOf = lineIndex(text);
  const entities: EntityFact[] = [];
  const MODEL = /^[ \t]*model[ \t]+([A-Za-z_][\w]*)[ \t]*\{/gm;
  for (const m of text.matchAll(MODEL)) {
    const name = m[1] as string;
    const bodyStart = (m.index as number) + m[0].length;
    const close = text.indexOf("}", bodyStart);
    const body = text.slice(bodyStart, close === -1 ? text.length : close);
    const fields: EntityField[] = [];
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("@@")) continue;
      const f = /^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*(?:\([^)]*\))?(?:\[\])?\??)/.exec(line);
      if (!f) continue;
      const field: EntityField = { name: f[1] as string, type: f[2] as string };
      // Provisional: settled by the linker against every declared model.
      if (!SCALARS.has(baseType(field.type))) field.relation = baseType(field.type);
      fields.push(field);
    }
    entities.push({ name, orm: ORM, file: input.rel, line: lineOf(m.index as number), fields });
  }
  return entities.length ? { entities } : {};
}

/** Accessor `orderItem` → candidate model name `OrderItem`. */
function modelFromAccessor(accessor: string): string {
  return accessor.charAt(0).toUpperCase() + accessor.slice(1);
}

function extractClient(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text, { strings: true });
  const lineOf = lineIndex(text);
  const ops = [...OP_KIND.keys()].join("|");
  // Receiver: `prisma`, `db`, `tx`, `client`, optionally behind `this.` / `ctx.`.
  const CALL = new RegExp(
    `(?<![\\w$])(?:(?:this|ctx|context)\\s*\\.\\s*)?(?:prisma|db|tx|client)\\s*\\.\\s*([a-z][A-Za-z0-9_]*)\\s*\\.\\s*(${ops})\\s*\\(`,
    "g",
  );
  const uses: EntityUseFact[] = [];
  for (const m of text.matchAll(CALL)) {
    const op = OP_KIND.get(m[2] as string);
    if (!op) continue;
    uses.push({ entity: modelFromAccessor(m[1] as string), file: input.rel, line: lineOf(m.index as number), op });
  }
  return uses.length ? { entityUses: uses } : {};
}

export const prismaSchemaExtractor: Extractor = {
  id: "prisma-schema",
  applies(input: ExtractInput): boolean {
    return input.rel.toLowerCase().endsWith(".prisma");
  },
  extract: extractSchema,
};

export const prismaClientExtractor: Extractor = {
  id: "prisma-client",
  applies(input: ExtractInput, ctx: RepoContext): boolean {
    if (!isJsLike(input.rel)) return false;
    const deps = ctx.depsFor(input.rel);
    return deps.has("@prisma/client") || deps.has("prisma");
  },
  extract: extractClient,
};

/**
 * Settle Prisma relations against the declared models: a field is a relation
 * only when its base type is a declared model (an enum or a composite type is
 * not).
 */
export const prismaLinker: Linker = {
  id: "prisma-relations",
  link(facts: Facts): Facts {
    const models = new Set(facts.entities.filter((e) => e.orm === ORM).map((e) => e.name));
    const entities = facts.entities.map((e) => {
      if (e.orm !== ORM) return e;
      return {
        ...e,
        fields: e.fields.map((f) => {
          const { relation, ...rest } = f;
          return relation && models.has(relation) ? { ...rest, relation } : rest;
        }),
      };
    });
    return { ...facts, entities };
  },
};

/**
 * An entity use must name a declared entity: exact, else case-insensitive
 * (Prisma's `orderitem` accessor style, `@@map`-free schemas). A use naming no
 * declared entity is dropped when the repo declares entities at all —
 * `db.cache.count()` on some other client is not a data model. With no schema
 * indexed, uses are kept as written.
 */
export const entityUseLinker: Linker = {
  id: "entity-uses",
  link(facts: Facts): Facts {
    const names = new Set(facts.entities.map((e) => e.name));
    if (!names.size) return facts;
    const byLower = new Map<string, string>();
    for (const n of [...names].sort()) if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
    const entityUses: EntityUseFact[] = [];
    for (const u of facts.entityUses) {
      if (names.has(u.entity)) entityUses.push(u);
      else {
        const name = byLower.get(u.entity.toLowerCase());
        if (name) entityUses.push({ ...u, entity: name });
      }
    }
    return { ...facts, entityUses };
  },
};
