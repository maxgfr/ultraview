// Mongoose: entities from `model("Name", schema)`, fields from the schema's
// definition object, relations from `ref: "Other"`; entity uses from model
// statics (`Product.find(…)`, `Order.create(…)`).
//
// The entity is named by `model()`'s first argument; its line is the schema's
// `new Schema(…)` when the schema is declared in the same file (else the
// `model()` call). Field types: `String` / `Schema.Types.ObjectId` → the last
// name, `[X]` → `X[]`, `{ type: X, ref: "Y" }` → X with relation Y, a nested
// object without `type` → `Object`.

import { importsModule, readArgs, stringLiteral } from "./js.js";
import { opTable, reachableModelNames, staticModelUses } from "./orm.js";
import { declares, importBindings, isScriptFile, namesImportedFrom, objectProps, propValue, sourceViews } from "./source.js";
import type { EntityFact, EntityField, ExtractInput, ExtractOutput, Extractor } from "./types.js";

const ORM = "mongoose";

const OPS = opTable(
  ["find", "findOne", "findById", "countDocuments", "estimatedDocumentCount", "exists", "aggregate", "distinct"],
  [
    "create",
    "insertMany",
    "updateOne",
    "updateMany",
    "replaceOne",
    "deleteOne",
    "deleteMany",
    "findOneAndUpdate",
    "findByIdAndUpdate",
    "findOneAndDelete",
    "findByIdAndDelete",
    "findOneAndReplace",
    "findOneAndRemove",
    "findByIdAndRemove",
    "bulkWrite",
  ],
);

/** A schema type expression's name: `String`, `Schema.Types.ObjectId` → `ObjectId`. */
function typeName(raw: string): string {
  const m = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)$/.exec(raw.trim());
  return m ? ((m[1] as string).split(".").pop() as string).trim() : "Mixed";
}

function schemaField(text: string, name: string, raw: string, start: number): EntityField {
  if (raw.startsWith("[")) {
    const inner = readArgs(text, start)?.args[0];
    if (!inner) return { name, type: "Array" };
    const f = schemaField(text, name, inner.raw, inner.start);
    return { ...f, type: `${f.type}[]` };
  }
  if (raw.startsWith("{")) {
    const obj = objectProps(text, start);
    const type = obj ? propValue(obj.props, "type") : undefined;
    if (!obj || !type) return { name, type: "Object" };
    const field = type.value.startsWith("[") ? schemaField(text, name, type.value, type.start) : { name, type: typeName(type.value) };
    const ref = propValue(obj.props, "ref");
    const target = ref ? stringLiteral(ref.value) : undefined;
    if (target) field.relation = target;
    return field;
  }
  return { name, type: typeName(raw) };
}

function schemaFields(text: string, open: number): EntityField[] {
  const obj = objectProps(text, open);
  if (!obj) return [];
  return obj.props.filter((p) => p.key).map((p) => schemaField(text, p.key, p.value, p.start));
}

function extractMongoose(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  const bindings = importBindings(text);
  const entities: EntityFact[] = [];
  const modelNames: string[] = [];
  if (importsModule(text, "mongoose")) {
    // Schemas declared in this file: variable → fields and offset.
    const schemas = new Map<string, { fields: EntityField[]; offset: number }>();
    const SCHEMA = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?Schema\s*(?:<[^()]*>)?\s*\(\s*\{/g;
    for (const m of skeleton.matchAll(SCHEMA)) {
      schemas.set(m[1] as string, { fields: schemaFields(text, (m.index as number) + m[0].length - 1), offset: m.index as number });
    }
    const esc = (names: string[]) => names.map((n) => n.replace(/\$/g, "\\$")).join("|");
    const modelFns = esc(["model", ...namesImportedFrom(bindings, "mongoose", "model")]);
    const owners = esc(["mongoose", "connection", "conn", "db", ...namesImportedFrom(bindings, "mongoose")]);
    const MODEL = new RegExp(`(?<![\\w$.])(?:${modelFns}|(?:${owners})\\s*\\.\\s*model)\\s*(?:<[^()]*>)?\\s*\\(`, "g");
    for (const m of skeleton.matchAll(MODEL)) {
      const call = readArgs(text, (m.index as number) + m[0].length - 1);
      const name = call?.args[0] ? stringLiteral(call.args[0].raw) : undefined;
      const schema = call?.args[1];
      if (!name || !schema) continue;
      let fields: EntityField[] = [];
      let offset = m.index as number;
      const known = schemas.get(schema.raw);
      if (known) {
        fields = known.fields;
        offset = known.offset;
      } else {
        const inline = /^new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?Schema\s*(?:<[^()]*>)?\s*\(\s*\{/.exec(schema.raw);
        if (inline) fields = schemaFields(text, schema.start + inline[0].length - 1);
      }
      entities.push({ name, orm: ORM, file: input.rel, line: lineOf(offset), fields });
      // The binding the model is assigned to (`export const Product = model("Product", …)`).
      const window = skeleton.slice(Math.max(0, (m.index as number) - 160), m.index as number);
      const decl = [...window.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=/g)].pop();
      if (decl && !window.slice(decl.index as number).includes(";")) modelNames.push(decl[1] as string);
      modelNames.push(name);
    }
  }
  const uses = staticModelUses(skeleton, input.rel, reachableModelNames(bindings, modelNames), OPS);
  const out: ExtractOutput = {};
  if (entities.length) out.entities = entities;
  if (uses.length) out.entityUses = uses;
  return out;
}

export const mongooseExtractor: Extractor = {
  id: "mongoose",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["mongoose"]);
  },
  extract: extractMongoose,
};
