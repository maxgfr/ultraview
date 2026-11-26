// Sequelize: entities from `sequelize.define("User", { … })`,
// `class User extends Model` + `User.init({ … })`, and sequelize-typescript
// `@Table` classes; relation fields from associations; entity uses from model
// statics (`User.findAll`, `Order.create`…).
//
// Field types drop the `DataTypes.` prefix and arguments (`STRING(255)` →
// `STRING`). Associations `A.hasMany(B, { as })`, `belongsTo`, `hasOne`,
// `belongsToMany` (also `this.hasMany(models.B)` inside `associate`) add a
// field to A — named by `as`, else B — through a `fields` hint, since
// associations are often wired in another file than the models.

import { importsModule, readArgs, stringLiteral } from "./js.js";
import { opTable, reachableModelNames, staticModelUses } from "./orm.js";
import { classDeclarations, classTarget, declares, importBindings, isScriptFile, objectProps, propValue, sourceViews } from "./source.js";
import type { EntityFact, EntityField, ExtractInput, ExtractOutput, Extractor, FieldsHint } from "./types.js";

const ORM = "sequelize";

const OPS = opTable(
  ["findAll", "findOne", "findByPk", "findAndCountAll", "count", "max", "min", "sum", "aggregate"],
  ["create", "bulkCreate", "update", "destroy", "upsert", "findOrCreate", "increment", "decrement", "truncate", "restore"],
);

const ASSOCIATIONS = new Map([
  ["hasMany", true],
  ["belongsToMany", true],
  ["hasOne", false],
  ["belongsTo", false],
]);

const TS_RELATIONS = new Map([
  ["HasMany", true],
  ["BelongsToMany", true],
  ["HasOne", false],
  ["BelongsTo", false],
]);

/** `DataTypes.STRING(255)` → `STRING`; `{ type: DataTypes.INTEGER, … }` → `INTEGER`. */
function columnType(text: string, raw: string, start: number): string {
  let src = raw;
  if (raw.startsWith("{")) {
    const type = propValue(objectProps(text, start)?.props ?? [], "type");
    if (!type) return "unknown";
    src = type.value;
  }
  const m = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)/.exec(src);
  return m ? (m[1] as string) : "unknown";
}

function attributeFields(text: string, open: number): EntityField[] {
  const obj = objectProps(text, open);
  if (!obj) return [];
  return obj.props.filter((p) => p.key).map((p) => ({ name: p.key, type: columnType(text, p.value, p.start) }));
}

function extractSequelize(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  const entities: EntityFact[] = [];
  const hints: FieldsHint[] = [];
  const declared: string[] = [];
  const classes = classDeclarations(skeleton, text);
  const usesSequelize = importsModule(text, "sequelize") || importsModule(text, "sequelize-typescript") || importsModule(text, "@sequelize/core");

  if (usesSequelize) {
    // sequelize.define("User", { … })
    for (const m of skeleton.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*define\s*(?:<[^()]*>)?\s*\(/g)) {
      const call = readArgs(text, (m.index as number) + m[0].length - 1);
      const name = call?.args[0] ? stringLiteral(call.args[0].raw) : undefined;
      const attrs = call?.args[1];
      if (!name || !attrs?.raw.startsWith("{")) continue;
      entities.push({ name, orm: ORM, file: input.rel, line: lineOf(m.index as number), fields: attributeFields(text, attrs.start) });
      const window = skeleton.slice(Math.max(0, (m.index as number) - 80), m.index as number);
      const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(window);
      declared.push(name, ...(decl ? [decl[1] as string] : []));
    }
    // class User extends Model {} + User.init({ … })
    const modelClasses = new Map(classes.filter((c) => /\bextends\s+Model\b/.test(c.heritage)).map((c) => [c.name, c]));
    for (const m of skeleton.matchAll(/(?<![\w$.])([A-Z][\w$]*)\s*\.\s*init\s*\(\s*\{/g)) {
      const cls = modelClasses.get(m[1] as string);
      if (!cls) continue;
      entities.push({
        name: cls.name,
        orm: ORM,
        file: input.rel,
        line: lineOf(cls.start),
        fields: attributeFields(text, (m.index as number) + m[0].length - 1),
      });
      declared.push(cls.name);
    }
    // sequelize-typescript: @Table class User extends Model { @Column name: string; @HasMany(() => Order) orders: Order[] }
    for (const cls of classes) {
      if (!cls.decorators.some((d) => d.name === "Table") || !modelClasses.has(cls.name)) continue;
      const fields: EntityField[] = [];
      for (const mem of cls.members) {
        if (mem.kind !== "property") continue;
        const rel = mem.decorators.find((d) => TS_RELATIONS.has(d.name));
        if (rel) {
          const target = classTarget(rel.args?.[0]?.raw);
          const field: EntityField = { name: mem.name, type: mem.type ?? target ?? "unknown" };
          if (target) field.relation = target;
          fields.push(field);
        } else if (mem.decorators.some((d) => d.name === "Column" || d.name === "PrimaryKey" || d.name === "ForeignKey")) {
          fields.push({ name: mem.name, type: mem.type ?? "unknown" });
        }
      }
      entities.push({ name: cls.name, orm: ORM, file: input.rel, line: lineOf(cls.decorators[0]?.start ?? cls.start), fields });
      declared.push(cls.name);
    }
  }

  // Associations, anywhere in a Sequelize workspace (models/index.js wires them without importing sequelize).
  for (const m of skeleton.matchAll(/(?<![\w$.])(this|[A-Z][\w$]*)\s*\.\s*(hasMany|belongsToMany|hasOne|belongsTo)\s*\(/g)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    const targetRaw = call?.args[0]?.raw;
    const target = targetRaw ? /^(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Z][\w$]*)$/.exec(targetRaw)?.[1] : undefined;
    if (!call || !target) continue;
    let owner = m[1] as string;
    if (owner === "this") {
      const cls = classes.filter((c) => c.bodyOpen < (m.index as number) && (m.index as number) < c.bodyEnd).pop();
      if (!cls) continue;
      owner = cls.name;
    }
    const opts = call.args[1]?.raw.startsWith("{") ? objectProps(text, call.args[1].start) : undefined;
    const as = opts ? propValue(opts.props, "as") : undefined;
    const alias = as ? stringLiteral(as.value) : undefined;
    const many = ASSOCIATIONS.get(m[2] as string) as boolean;
    hints.push({
      kind: "fields",
      orm: ORM,
      entity: owner,
      file: input.rel,
      line: lineOf(m.index as number),
      fields: [{ name: alias ?? target, type: many ? `${target}[]` : target, relation: target }],
    });
  }

  const uses = staticModelUses(skeleton, input.rel, reachableModelNames(importBindings(text), declared), OPS);
  // sequelize-cli style registries: `models.User.findAll()`, `db.Order.create()`.
  const ops = [...OPS.keys()].join("|");
  for (const m of skeleton.matchAll(new RegExp(`(?<![\\w$.])(?:models|db)\\s*\\.\\s*([A-Z][\\w$]*)\\s*\\.\\s*(${ops})\\s*\\(`, "g"))) {
    uses.push({ entity: m[1] as string, file: input.rel, line: lineOf(m.index as number), op: OPS.get(m[2] as string) as "read" | "write" });
  }
  const out: ExtractOutput = {};
  if (entities.length) out.entities = entities;
  if (uses.length) out.entityUses = uses;
  if (hints.length) out.hints = hints;
  return out;
}

export const sequelizeExtractor: Extractor = {
  id: "sequelize",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["sequelize", "sequelize-typescript", "@sequelize/core"]);
  },
  extract: extractSequelize,
};
