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
// Table creators: `const createTable = pgTableCreator((name) => \`app_${name}\`)`
// (also mysql / sqlite / singlestore, through a namespace or an aliased
// import) is a table factory: `createTable("user", (d) => ({ id: d.varchar() }))`
// declares a table like `pgTable` does, in the same file or in a file that
// imports the creator from a repo module (`table-factory` / `table-call`
// hints, resolved by the `drizzle-tables` linker). Callback columns built from
// the parameter (`d.varchar(…)`) are typed by the builder method.
//
// Physical names: each table leaves a `TableHint` with the name the database
// sees — the literal for `pgTable("users")`, the creator's template applied to
// it (`app_user`) when that template is literals, same-file string constants
// and the name once. The `drizzle-sql` linker then folds a SQL `CREATE TABLE`
// entity of that name into the Drizzle entity, so a table declared in the ORM
// and in its migrations is one entity.
//
// Uses: `db.select(…).from(t)` and its joins, `db.query.t.findMany/findFirst`,
// `db.$count(t)` → read; `db.insert(t)`, `db.update(t)`, `db.delete(t)` →
// write. Receivers: `db`, `tx`, `trx`, `database` (optionally `this.` /
// `ctx.`) and names assigned `drizzle(…)`. The table argument must be a table
// the file declares or imports from a repo module.

import { importsModule, readArgs, skipString, stringLiteral } from "./js.js";
import {
  chainAfter,
  declares,
  defaultExportName,
  exportedNames,
  type ImportBinding,
  importBindings,
  isLocalSpecifier,
  isScriptFile,
  objectProps,
  resolveLocalModule,
  sourceViews,
  stringConstants,
} from "./source.js";
import type {
  EntityFact,
  EntityField,
  EntityUseFact,
  ExtractInput,
  ExtractOutput,
  Extractor,
  Facts,
  LinkContext,
  LinkHint,
  Linker,
  RepoContext,
  TableCallHint,
  TableFactoryHint,
  TableHint,
} from "./types.js";

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

const CREATOR = /^(?:pg|mysql|sqlite|singlestore)TableCreator$/;

const escapeName = (n: string) => n.replace(/\$/g, "\\$");

/** `const <name> = <callee>(` for any of `callees`, on the skeleton. */
function assignedCalls(callees: Iterable<string>): RegExp | undefined {
  const alt = [...callees].sort().map(escapeName).join("|");
  return alt ? new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*(${alt})\\s*\\(`, "g") : undefined;
}

export interface NameTemplate {
  prefix: string;
  suffix: string;
}

/** Split `raw` on top-level `+`, strings and brackets skipped. */
function plusTerms(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(raw, i) - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "+" && depth === 0) {
      out.push(raw.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(raw.slice(from).trim());
  return out;
}

/**
 * The physical-name template of a table creator's callback:
 * `(name) => \`app_${name}\`` → `{ prefix: "app_", suffix: "" }`. The body may
 * be a template literal or a `+` concatenation of string literals, same-file
 * string constants (`consts`) and the parameter, which must appear exactly
 * once. Anything else (calls, other variables) is not computable: undefined.
 */
export function tableNameTemplate(raw: string, consts: ReadonlyMap<string, string>): NameTemplate | undefined {
  const fn = /^(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?\)|([A-Za-z_$][\w$]*))\s*(?::\s*string\s*)?=>\s*([\s\S]+)$/.exec(raw.trim());
  if (!fn) return undefined;
  const param = (fn[1] ?? fn[2]) as string;
  let body = (fn[3] as string).trim();
  const block = /^\{\s*return\s+([\s\S]+?)\s*;?\s*\}$/.exec(body);
  if (block) body = (block[1] as string).trim();
  while (body.startsWith("(") && readArgs(body, 0)?.end === body.length) body = body.slice(1, -1).trim();
  // Parts in order; `null` marks the parameter.
  const parts: (string | null)[] = [];
  const operand = (expr: string): boolean => {
    if (expr === param) parts.push(null);
    else if (consts.has(expr)) parts.push(consts.get(expr) as string);
    else return false;
    return true;
  };
  for (const term of plusTerms(body)) {
    if (/^[A-Za-z_$][\w$]*$/.test(term)) {
      if (!operand(term)) return undefined;
      continue;
    }
    const lit = stringLiteral(term);
    if (lit !== undefined) {
      if (lit.includes("\\")) return undefined;
      parts.push(lit);
      continue;
    }
    if (!term.startsWith("`") || !term.endsWith("`") || term.includes("\\")) return undefined;
    const inner = term.slice(1, -1);
    let pos = 0;
    for (const m of inner.matchAll(/\$\{\s*([^{}]*?)\s*\}/g)) {
      parts.push(inner.slice(pos, m.index as number));
      if (!operand(m[1] as string)) return undefined;
      pos = (m.index as number) + m[0].length;
    }
    const tail = inner.slice(pos);
    if (tail.includes("${")) return undefined;
    parts.push(tail);
  }
  const at = parts.indexOf(null);
  if (at === -1 || parts.lastIndexOf(null) !== at) return undefined;
  return { prefix: parts.slice(0, at).join(""), suffix: parts.slice(at + 1).join("") };
}

/** The `{` of a table call's columns, and its fields. */
function tableFields(text: string, cols: { raw: string; start: number } | undefined): EntityField[] {
  if (!cols) return [];
  const open = objectOpen(cols.raw, cols.start);
  return open === undefined ? [] : columnFields(text, open);
}

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

/** `const x = f("name", columns, …)`: the bound name, the table name as written, the fields. */
function tableCalls(
  text: string,
  skeleton: string,
  re: RegExp | undefined,
): { entity: string; callee: string; table: string; fields: EntityField[]; at: number }[] {
  const out: { entity: string; callee: string; table: string; fields: EntityField[]; at: number }[] = [];
  for (const m of re ? skeleton.matchAll(re) : []) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    const table = call && call.args.length >= 2 ? stringLiteral((call.args[0] as { raw: string }).raw) : undefined;
    if (!call || table === undefined) continue;
    out.push({ entity: m[1] as string, callee: (m[2] ?? "").replace(/\s+/g, ""), table, fields: tableFields(text, call.args[1]), at: m.index as number });
  }
  return out;
}

function extractDrizzle(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  // Tables and relations are declared with drizzle-orm's own helpers; queries
  // only need the client, often imported from a repo module.
  const declaresSchema = importsModule(text, "drizzle-orm");
  const bindings = importBindings(text);
  const entities: EntityFact[] = [];
  const hints: LinkHint[] = [];
  const uses: EntityUseFact[] = [];
  const tableHint = (entity: string, table: string, at: number): TableHint => ({ kind: "table", orm: ORM, entity, table, file: input.rel, line: lineOf(at) });

  for (const m of declaresSchema ? skeleton.matchAll(TABLE_CALL) : []) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    const table = call && call.args.length >= 2 ? stringLiteral((call.args[0] as { raw: string }).raw) : undefined;
    if (!call || table === undefined) continue;
    const at = m.index as number;
    entities.push({ name: m[1] as string, orm: ORM, file: input.rel, line: lineOf(at), fields: tableFields(text, call.args[1]) });
    hints.push(tableHint(m[1] as string, table, at));
  }

  // Table creators this file declares: local name → physical-name template.
  const creators = new Map<string, NameTemplate | undefined>();
  if (declaresSchema) {
    const callees = ["(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?(?:pg|mysql|sqlite|singlestore)TableCreator"];
    for (const [local, b] of bindings)
      if (CREATOR.test(b.imported) && (b.spec === "drizzle-orm" || b.spec.startsWith("drizzle-orm/"))) callees.push(escapeName(local));
    const re = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*(?:${callees.join("|")})\\s*\\(`, "g");
    const consts = stringConstants(text);
    for (const m of skeleton.matchAll(re)) {
      const call = readArgs(text, (m.index as number) + m[0].length - 1);
      const fn = call?.args[0];
      creators.set(m[1] as string, fn ? tableNameTemplate(fn.raw, consts) : undefined);
    }
  }
  for (const t of tableCalls(text, skeleton, assignedCalls(creators.keys()))) {
    entities.push({ name: t.entity, orm: ORM, file: input.rel, line: lineOf(t.at), fields: t.fields });
    const template = creators.get(t.callee);
    if (template) hints.push(tableHint(t.entity, `${template.prefix}${t.table}${template.suffix}`, t.at));
  }
  // Creators other modules can import.
  const exportedCreator = (name: string, local: string, at: number) => {
    if (!creators.has(local)) return;
    const template = creators.get(local);
    const hint: TableFactoryHint = { kind: "table-factory", orm: ORM, file: input.rel, line: lineOf(at), name };
    if (template) hint.template = template;
    hints.push(hint);
  };
  if (creators.size) {
    for (const e of exportedNames(skeleton)) exportedCreator(e.name, e.local, e.offset);
    const def = defaultExportName(skeleton);
    if (def) exportedCreator("default", def, skeleton.search(/\bexport\s+default\b/));
  }

  // Calls to a function imported from a repo module: tables if that module exports a creator by that name.
  const imported: string[] = [];
  for (const [local, b] of bindings) if (b.imported !== "*" && isLocalSpecifier(b.spec) && !creators.has(local)) imported.push(local);
  const candidates = new Set<string>();
  for (const t of tableCalls(text, skeleton, assignedCalls(imported))) {
    const b = bindings.get(t.callee) as ImportBinding;
    const module = resolveLocalModule(ctx, input.rel, b.spec);
    if (!module) continue;
    const hint: TableCallHint = {
      kind: "table-call",
      orm: ORM,
      file: input.rel,
      line: lineOf(t.at),
      module,
      name: b.imported,
      entity: t.entity,
      table: t.table,
      fields: t.fields,
    };
    hints.push(hint);
    candidates.add(t.entity);
  }

  for (const m of declaresSchema ? skeleton.matchAll(/(?<![\w$.])relations\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g) : []) {
    const call = readArgs(text, skeleton.indexOf("(", m.index as number));
    const second = call?.args[1];
    if (!second) continue;
    const fields = relationFields(text, second.raw, second.start);
    if (fields.length) hints.push({ kind: "fields", orm: ORM, entity: m[1] as string, file: input.rel, line: lineOf(m.index as number), fields });
  }

  // Candidates count as declared here; `entity-uses` drops uses of the ones no creator backs.
  const declared = new Set([...entities.map((e) => e.name), ...candidates]);
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

/** Imported-creator table calls whose module exports a creator by that name, with the creator. */
function importedTables(hints: readonly LinkHint[]): { call: TableCallHint; factory: TableFactoryHint }[] {
  const factories = new Map<string, TableFactoryHint>();
  for (const h of hints) if (h.kind === "table-factory" && !factories.has(`${h.file}\u0000${h.name}`)) factories.set(`${h.file}\u0000${h.name}`, h);
  const out: { call: TableCallHint; factory: TableFactoryHint }[] = [];
  for (const h of hints) {
    if (h.kind !== "table-call") continue;
    const factory = factories.get(`${h.module}\u0000${h.name}`);
    if (factory && factory.orm === h.orm) out.push({ call: h, factory });
  }
  return out;
}

/**
 * Tables declared through a creator imported from another module: an entity
 * per call whose module exports a table creator by the imported name. Runs
 * before `orm-fields`, so `relations()` and `.references()` reach them.
 */
export const drizzleTablesLinker: Linker = {
  id: "drizzle-tables",
  link(facts: Facts, ctx: LinkContext): Facts {
    const found = importedTables(ctx.hints);
    if (!found.length) return facts;
    const added: EntityFact[] = found.map(({ call }) => ({
      name: call.entity,
      orm: call.orm,
      file: call.file,
      line: call.line,
      fields: call.fields.map((f) => ({ ...f })),
    }));
    return { ...facts, entities: [...facts.entities, ...added] };
  },
};

/**
 * One entity per table: a SQL `CREATE TABLE` entity whose name is the
 * physical name of a declared Drizzle table (case-insensitive) is folded into
 * that Drizzle entity — the ORM declaration is what queries name. The SQL
 * entity is dropped; relations of the remaining SQL entities and entity uses
 * (SQL literals) naming it are renamed to the Drizzle entity. Runs after
 * `orm-relations` and `sql-uses`, which settle SQL names first.
 */
export const drizzleSqlLinker: Linker = {
  id: "drizzle-sql",
  link(facts: Facts, ctx: LinkContext): Facts {
    const drizzle = new Set(facts.entities.filter((e) => e.orm === ORM).map((e) => e.name));
    if (!drizzle.size || !facts.entities.some((e) => e.orm === "sql")) return facts;
    const physical: { entity: string; table: string; file: string; line: number }[] = [];
    for (const h of ctx.hints) if (h.kind === "table" && h.orm === ORM) physical.push(h);
    for (const { call, factory } of importedTables(ctx.hints)) {
      if (factory.template)
        physical.push({ entity: call.entity, table: `${factory.template.prefix}${call.table}${factory.template.suffix}`, file: call.file, line: call.line });
    }
    physical.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const tables = new Map<string, string>();
    for (const p of physical) if (drizzle.has(p.entity) && !tables.has(p.table.toLowerCase())) tables.set(p.table.toLowerCase(), p.entity);
    const renamed = new Map<string, string>();
    const kept = facts.entities.filter((e) => {
      const to = e.orm === "sql" ? tables.get(e.name.toLowerCase()) : undefined;
      if (to) renamed.set(e.name, to);
      return !to;
    });
    if (!renamed.size) return facts;
    const entities = kept.map((e) =>
      e.orm === "sql" && e.fields.some((f) => f.relation && renamed.has(f.relation))
        ? { ...e, fields: e.fields.map((f) => (f.relation && renamed.has(f.relation) ? { ...f, relation: renamed.get(f.relation) as string } : f)) }
        : e,
    );
    const entityUses = facts.entityUses.map((u) => (renamed.has(u.entity) ? { ...u, entity: renamed.get(u.entity) as string } : u));
    return { ...facts, entities, entityUses };
  },
};
