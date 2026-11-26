// Pieces shared by the JS ORM extractors (Drizzle, TypeORM, Mongoose,
// Sequelize): model-method uses on names a file can provably reach, and the
// `orm-fields` linker that merges fields declared away from their entity and
// settles relations against the declared entities.

import { lineIndex } from "./mask.js";
import { type ImportBinding, isLocalSpecifier } from "./source.js";
import type { EntityField, EntityUseFact, Facts, LinkContext, Linker } from "./types.js";

export type OpKind = "read" | "write";

export function opTable(read: readonly string[], write: readonly string[]): Map<string, OpKind> {
  return new Map<string, OpKind>([...read.map((o) => [o, "read"] as const), ...write.map((o) => [o, "write"] as const)]);
}

/** Built-ins that share method names with ORMs (`Object.create`, `Array.find`…): never models. */
const GLOBALS = new Set([
  "Object",
  "Array",
  "Promise",
  "JSON",
  "Math",
  "Date",
  "Reflect",
  "Map",
  "Set",
  "WeakMap",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "Error",
  "Intl",
  "Buffer",
  "URL",
  "Response",
  "Request",
]);

/**
 * Capitalized names a file can use as models: bound by an import from a repo
 * module (relative or alias — never a package), or declared in the file.
 */
export function reachableModelNames(bindings: Map<string, ImportBinding>, declared: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const [local, b] of bindings) if (/^[A-Z]/.test(local) && isLocalSpecifier(b.spec) && b.imported !== "*") out.add(local);
  for (const d of declared) if (/^[A-Z]/.test(d)) out.add(d);
  for (const g of GLOBALS) out.delete(g);
  return out;
}

/** `Model.op(` calls on `names` with a known operation, on the string-blanked skeleton. */
export function staticModelUses(skeleton: string, rel: string, names: ReadonlySet<string>, ops: ReadonlyMap<string, OpKind>): EntityUseFact[] {
  if (!names.size) return [];
  const lineOf = lineIndex(skeleton);
  const alt = [...names]
    .sort()
    .map((n) => n.replace(/\$/g, "\\$"))
    .join("|");
  const re = new RegExp(`(?<![\\w$.])(${alt})\\s*\\.\\s*(${[...ops.keys()].join("|")})\\s*(?:<[^()]*>)?\\s*\\(`, "g");
  const out: EntityUseFact[] = [];
  for (const m of skeleton.matchAll(re))
    out.push({ entity: m[1] as string, file: rel, line: lineOf(m.index as number), op: ops.get(m[2] as string) as OpKind });
  return out;
}

/** The ORMs whose relations this linker settles (Prisma has its own). */
const JS_ORMS = new Set(["drizzle", "typeorm", "mongoose", "sequelize"]);

/**
 * Merge `fields` hints (Drizzle `relations()`, Sequelize associations) into
 * the entity they name — same ORM, matched by name; a field already declared
 * keeps its declaration and gains the relation. Hints naming no declared
 * entity, and hinted relations to an undeclared target, are dropped. Then a
 * relation is kept only when it names a declared entity: an undeclared target
 * is not a data model of this repo.
 */
export const ormFieldsLinker: Linker = {
  id: "orm-fields",
  link(facts: Facts, ctx: LinkContext): Facts {
    const extra = new Map<string, EntityField[]>();
    for (const h of ctx.hints) {
      if (h.kind !== "fields") continue;
      const key = `${h.orm}\u0000${h.entity}`;
      const list = extra.get(key) ?? [];
      list.push(...h.fields);
      extra.set(key, list);
    }
    const declared = new Set(facts.entities.map((e) => e.name));
    if (!extra.size && !facts.entities.some((e) => JS_ORMS.has(e.orm))) return facts;
    const entities = facts.entities.map((e) => {
      if (!JS_ORMS.has(e.orm)) return e;
      const fields = e.fields.map((f) => ({ ...f }));
      for (const f of extra.get(`${e.orm}\u0000${e.name}`) ?? []) {
        // A hinted field exists only as a relation: none to an undeclared entity.
        if (f.relation && !declared.has(f.relation)) continue;
        const same = fields.find((x) => x.name === f.name);
        if (!same) fields.push({ ...f });
        else if (f.relation && !same.relation) same.relation = f.relation;
      }
      return {
        ...e,
        fields: fields.map((f) => {
          const { relation, ...rest } = f;
          return relation && declared.has(relation) ? { ...rest, relation } : rest;
        }),
      };
    });
    return { ...facts, entities };
  },
};
