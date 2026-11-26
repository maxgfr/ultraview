// TypeORM: entities from `@Entity()` classes, entity uses from repositories.
//
// Entities: a class decorated `@Entity` (or `@ChildEntity` / `@ViewEntity`)
// in a file importing typeorm; each property decorated with a column
// decorator (`@Column`, `@PrimaryGeneratedColumn`, `@CreateDateColumn`…) is a
// field typed by its TypeScript annotation; `@ManyToOne(() => User)`,
// `@OneToMany`, `@OneToOne`, `@ManyToMany` make it a relation to the target.
//
// Uses: repositories bound to an entity — `getRepository(User)` /
// `dataSource.getRepository(User)` assignments, `@InjectRepository(User) repo`,
// properties typed `Repository<User>` — then `repo.find*/count/…` → read and
// `repo.save/insert/update/upsert/delete/remove/…` → write; chained
// `getRepository(User).find(…)`; EntityManager calls `manager.find(User, …)`;
// and Active Record statics `User.find(…)` on reachable entity classes.

import { importsModule } from "./js.js";
import { opTable, reachableModelNames, staticModelUses } from "./orm.js";
import { classDeclarations, classTarget, declares, importBindings, isScriptFile, sourceViews } from "./source.js";
import type { EntityFact, EntityField, EntityUseFact, ExtractInput, ExtractOutput, Extractor } from "./types.js";

const ORM = "typeorm";

const ENTITY_DECORATORS = new Set(["Entity", "ChildEntity", "ViewEntity"]);
const COLUMN_DECORATORS = new Set([
  "Column",
  "PrimaryColumn",
  "PrimaryGeneratedColumn",
  "CreateDateColumn",
  "UpdateDateColumn",
  "DeleteDateColumn",
  "VersionColumn",
  "ObjectIdColumn",
  "ViewColumn",
]);
const RELATION_DECORATORS = new Set(["ManyToOne", "OneToMany", "OneToOne", "ManyToMany"]);

const OPS = opTable(
  [
    "find",
    "findOne",
    "findOneBy",
    "findBy",
    "findAndCount",
    "findAndCountBy",
    "findOneOrFail",
    "findOneByOrFail",
    "count",
    "countBy",
    "exist",
    "exists",
    "existsBy",
    "sum",
    "average",
    "minimum",
    "maximum",
  ],
  ["save", "insert", "update", "upsert", "delete", "remove", "softDelete", "softRemove", "restore", "recover", "increment", "decrement", "clear"],
);
const OP_ALT = [...OPS.keys()].join("|");

function extractTypeorm(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  const entities: EntityFact[] = [];
  const classes = classDeclarations(skeleton, text);
  if (importsModule(text, "typeorm")) {
    for (const cls of classes) {
      if (!cls.decorators.some((d) => ENTITY_DECORATORS.has(d.name))) continue;
      const fields: EntityField[] = [];
      for (const m of cls.members) {
        if (m.kind !== "property") continue;
        const rel = m.decorators.find((d) => RELATION_DECORATORS.has(d.name));
        if (rel) {
          const target = classTarget(rel.args?.[0]?.raw);
          const field: EntityField = { name: m.name, type: m.type ?? target ?? "unknown" };
          if (target) field.relation = target;
          fields.push(field);
        } else if (m.decorators.some((d) => COLUMN_DECORATORS.has(d.name))) fields.push({ name: m.name, type: m.type ?? "unknown" });
      }
      entities.push({ name: cls.name, orm: ORM, file: input.rel, line: lineOf(cls.decorators[0]?.start ?? cls.start), fields });
    }
  }

  // Repository variables → entity.
  const repos = new Map<string, string>();
  const REPO_ASSIGN =
    /([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(?:await\s+)?(?:[A-Za-z_$][\w$.]*\s*\.\s*)?get(?:Mongo|Tree)?Repository\s*(?:<[^()]*>)?\s*\(\s*([A-Z][\w$]*)\s*\)/g;
  for (const m of skeleton.matchAll(REPO_ASSIGN)) repos.set(m[1] as string, m[2] as string);
  for (const m of skeleton.matchAll(/@InjectRepository\s*\(\s*([A-Z][\w$]*)\s*\)\s*(?:(?:private|public|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/g)) {
    repos.set(m[2] as string, m[1] as string);
  }
  for (const m of skeleton.matchAll(/([A-Za-z_$][\w$]*)\s*[!?]?\s*:\s*(?:Repository|MongoRepository|TreeRepository)\s*<\s*([A-Z][\w$]*)\s*>/g)) {
    if (!repos.has(m[1] as string)) repos.set(m[1] as string, m[2] as string);
  }

  const uses: EntityUseFact[] = [];
  if (repos.size) {
    const alt = [...repos.keys()].map((r) => r.replace(/\$/g, "\\$")).join("|");
    for (const m of skeleton.matchAll(new RegExp(`(?<![\\w$])(?:this\\s*\\.\\s*)?(${alt})\\s*\\.\\s*(${OP_ALT})\\s*(?:<[^()]*>)?\\s*\\(`, "g"))) {
      const before = skeleton.slice(Math.max(0, (m.index as number) - 1), m.index as number);
      if (before === ".") continue;
      uses.push({
        entity: repos.get(m[1] as string) as string,
        file: input.rel,
        line: lineOf(m.index as number),
        op: OPS.get(m[2] as string) as "read" | "write",
      });
    }
  }
  for (const m of skeleton.matchAll(new RegExp(`get(?:Mongo|Tree)?Repository\\s*\\(\\s*([A-Z][\\w$]*)\\s*\\)\\s*\\.\\s*(${OP_ALT})\\s*\\(`, "g"))) {
    uses.push({ entity: m[1] as string, file: input.rel, line: lineOf(m.index as number), op: OPS.get(m[2] as string) as "read" | "write" });
  }
  for (const m of skeleton.matchAll(
    new RegExp(`(?<![\\w$])(?:manager|entityManager|em)\\s*\\.\\s*(${OP_ALT})\\s*(?:<[^()]*>)?\\s*\\(\\s*([A-Z][\\w$]*)\\s*[,)]`, "g"),
  )) {
    uses.push({ entity: m[2] as string, file: input.rel, line: lineOf(m.index as number), op: OPS.get(m[1] as string) as "read" | "write" });
  }
  // Active Record: `User.find()` on a reachable class (BaseEntity statics).
  const names = reachableModelNames(
    importBindings(text),
    classes.filter((c) => /\bextends\s+BaseEntity\b/.test(c.heritage)).map((c) => c.name),
  );
  uses.push(...staticModelUses(skeleton, input.rel, names, OPS));

  const out: ExtractOutput = {};
  if (entities.length) out.entities = entities;
  if (uses.length) out.entityUses = uses;
  return out;
}

export const typeormExtractor: Extractor = {
  id: "typeorm",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["typeorm"]);
  },
  extract: extractTypeorm,
};
