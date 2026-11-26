// Drizzle ORM: entities from table declarations, relation fields from
// `.references()` and `relations()`, entity uses from query-builder calls.
//
// Entities: `export const users = pgTable("users", { id: serial("id"), … })`
// (also mysqlTable, sqliteTable, singlestoreTable, `schema.table(…)`, and the
// callback form `(t) => ({ … })`). The entity is named by the exported const —
// the identifier queries use — and each column key is a field typed by its
// column builder (`serial`, `text`, `integer`…). `.references(() => users.id)`
// makes the field a relation to `users`. `relations(users, ({ one, many }) =>
// ({ posts: many(posts) }))`, often in another file, adds fields through a
// `fields` hint.
//
// Uses: `db.select(…).from(t)` and its joins, `db.query.t.findMany/findFirst`,
// `db.$count(t)` → read; `db.insert(t)`, `db.update(t)`, `db.delete(t)` →
// write. Receivers: `db`, `tx`, `trx`, `database` (optionally `this.` /
// `ctx.`) and names assigned `drizzle(…)`. The table argument must be a table
// the file declares or imports from a repo module.

import { importsModule, readArgs, stringLiteral } from "./js.js";
import { chainAfter, declares, type ImportBinding, importBindings, isLocalSpecifier, isScriptFile, objectProps, sourceViews } from "./source.js";
import type { EntityFact, EntityField, EntityUseFact, ExtractInput, ExtractOutput, Extractor, FieldsHint } from "./types.js";

const ORM = "drizzle";

/** The `{` of a columns argument: an object literal, or the object a callback returns (`(t) => ({ … })`). */
function objectOpen(raw: string, start: number): number | undefined {
  if (raw.startsWith("{")) return start;
  const arrow = raw.indexOf("=>");
  if (arrow === -1) return undefined;
  const brace = raw.indexOf("{", arrow);
  if (brace === -1) return undefined;
  return start + brace;
}

function columnFields(text: string, open: number): EntityField[] {
  const obj = objectProps(text, open);
  if (!obj) return [];
  const fields: EntityField[] = [];
  for (const p of obj.props) {
    if (!p.key) continue;
    const builder = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/.exec(p.value);
    if (!builder) continue;
    const field: EntityField = { name: p.key, type: builder[1] as string };
    const ref = /\.\s*references\s*\(\s*\(\s*\)\s*(?::\s*[\w$]+\s*)?=>\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$]/.exec(p.value);
    if (ref) field.relation = ref[1] as string;
    fields.push(field);
  }
  return fields;
}

function relationFields(text: string, raw: string, start: number): EntityField[] {
  const open = objectOpen(raw, start);
  if (open === undefined) return [];
  const obj = objectProps(text, open);
  if (!obj) return [];
  const fields: EntityField[] = [];
  for (const p of obj.props) {
    const m = /^(one|many)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)/.exec(p.value);
    if (!p.key || !m) continue;
    const target = m[2] as string;
    fields.push({ name: p.key, type: m[1] === "many" ? `${target}[]` : target, relation: target });
  }
  return fields;
}

const TABLE_CALL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:(?:pg|mysql|sqlite|singlestore)Table|[A-Za-z_$][\w$]*\s*\.\s*table)\s*\(/g;

/** Is `raw` (`users`, `schema.users`) a table this file declares or imports from a repo module? Returns the table name. */
function tableArg(raw: string, declared: ReadonlySet<string>, bindings: Map<string, ImportBinding>): string | undefined {
  const m = /^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?$/.exec(raw.trim());
  if (!m) return undefined;
  const head = m[1] as string;
  const b = bindings.get(head);
  if (m[2]) return b && b.imported === "*" && isLocalSpecifier(b.spec) ? m[2] : undefined;
  if (declared.has(head)) return head;
  return b && isLocalSpecifier(b.spec) && b.imported !== "*" ? head : undefined;
}

function extractDrizzle(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  // Tables and relations are declared with drizzle-orm's own helpers; queries
  // only need the client, often imported from a repo module.
  const declaresSchema = importsModule(text, "drizzle-orm");
  const bindings = importBindings(text);
  const entities: EntityFact[] = [];
  const hints: FieldsHint[] = [];
  const uses: EntityUseFact[] = [];

  for (const m of declaresSchema ? skeleton.matchAll(TABLE_CALL) : []) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call || call.args.length < 2 || stringLiteral((call.args[0] as { raw: string }).raw) === undefined) continue;
    const cols = call.args[1] as { raw: string; start: number };
    const open = objectOpen(cols.raw, cols.start);
    entities.push({
      name: m[1] as string,
      orm: ORM,
      file: input.rel,
      line: lineOf(m.index as number),
      fields: open === undefined ? [] : columnFields(text, open),
    });
  }

  for (const m of declaresSchema ? skeleton.matchAll(/(?<![\w$.])relations\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g) : []) {
    const call = readArgs(text, skeleton.indexOf("(", m.index as number));
    const second = call?.args[1];
    if (!second) continue;
    const fields = relationFields(text, second.raw, second.start);
    if (fields.length) hints.push({ kind: "fields", orm: ORM, entity: m[1] as string, file: input.rel, line: lineOf(m.index as number), fields });
  }

  const declared = new Set(entities.map((e) => e.name));
  const clients = ["db", "tx", "trx", "database"];
  for (const m of skeleton.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:await\s+)?drizzle\s*\(/g)) clients.push(m[1] as string);
  const recv = `(?<![\\w$.])(?:(?:this|ctx|context)\\s*\\.\\s*)?(?:${[...new Set(clients)].map((c) => c.replace(/\$/g, "\\$")).join("|")})\\s*\\.\\s*`;
  const ARG = "([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)?)";
  const push = (raw: string, offset: number, op: "read" | "write") => {
    const entity = tableArg(raw, declared, bindings);
    if (entity) uses.push({ entity, file: input.rel, line: lineOf(offset), op });
  };
  for (const m of skeleton.matchAll(new RegExp(`${recv}(?:insert|update|delete)\\s*\\(\\s*${ARG}\\s*\\)`, "g")))
    push(m[1] as string, m.index as number, "write");
  for (const m of skeleton.matchAll(new RegExp(`${recv}\\$count\\s*\\(\\s*${ARG}\\s*[,)]`, "g"))) push(m[1] as string, m.index as number, "read");
  for (const m of skeleton.matchAll(new RegExp(`${recv}query\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:findMany|findFirst)\\s*\\(`, "g"))) {
    // The relational API names tables by their schema key, which the file need not import.
    uses.push({ entity: m[1] as string, file: input.rel, line: lineOf(m.index as number), op: "read" });
  }
  for (const m of skeleton.matchAll(new RegExp(`${recv}(?:select|selectDistinct|selectDistinctOn)\\s*\\(`, "g"))) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    for (const c of chainAfter(skeleton, text, call.end)) {
      if (!/^(?:from|(?:inner|left|right|full|cross)Join)$/.test(c.name) || !c.args[0]) continue;
      push(c.args[0].raw, m.index as number, "read");
    }
  }

  const out: ExtractOutput = {};
  if (entities.length) out.entities = entities;
  if (uses.length) out.entityUses = uses;
  if (hints.length) out.hints = hints;
  return out;
}

export const drizzleExtractor: Extractor = {
  id: "drizzle",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["drizzle-orm"]);
  },
  extract: extractDrizzle,
};
