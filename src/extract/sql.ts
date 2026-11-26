// SQL: entities from `CREATE TABLE` statements in `*.sql` files (migrations
// included), and entity uses from SQL statement literals in code.
//
// Schema: `CREATE TABLE [IF NOT EXISTS] [schema.]name (…)` — each column is a
// field (`name type`), an inline `REFERENCES other` or a table-level
// `[CONSTRAINT c] FOREIGN KEY (col) REFERENCES other` makes it a relation
// (settled by the `orm-relations` linker). Temporary tables are not data
// models. The entity's name is the table name as written, schema and quotes
// (`"…"`, backticks, `[…]`) dropped. A composite foreign key makes every one of
// its columns a relation to the referenced table.
//
// Migrations: each file's `CREATE TABLE`, `ALTER TABLE [IF EXISTS] [ONLY]` and
// `DROP TABLE` statements also go, in file order, into a `SqlDdlHint`. The
// `sql-migrations` linker replays them across files in migration order (see
// `migrationOrder`) into ONE entity per table (case-insensitive name): the
// latest `CREATE TABLE` wins and is the citation, later `ALTER TABLE` actions
// apply on top (`ADD [COLUMN]`, `DROP [COLUMN]`, `RENAME [COLUMN] a TO b`,
// `ALTER [COLUMN] c [SET DATA] TYPE t`, `ADD [CONSTRAINT c] FOREIGN KEY (…)
// REFERENCES t` — how drizzle-kit, Prisma, pg_dump and Rails `structure.sql`
// write foreign keys —, `DROP CONSTRAINT c` / `DROP FOREIGN KEY c` for a
// constraint added that way, `RENAME TO t`), and a `DROP TABLE` not followed
// by a new `CREATE TABLE` removes the entity. Down migrations are not the
// schema: `*.down.sql` / `down.sql` files and the down sections of dbmate,
// goose and sql-migrate files are skipped. Not replayed: MySQL `MODIFY` /
// `CHANGE`, parenthesized `ADD (a int, b int)`.
//
// Literals: a string literal in code holding `INSERT INTO t`, `UPDATE t SET`,
// `DELETE FROM t`, or `SELECT … FROM t` / `JOIN t`. Keywords must be upper
// case, or lower case at the very start of the literal ("update the order"
// in a log message is prose, not SQL). Each becomes a `SqlUseHint`; the
// `sql-uses` linker keeps it only when the table is declared — by a
// `CREATE TABLE`, else by an ORM entity's table (`__tablename__`).

import { readArgs } from "./js.js";
import { commentSyntaxFor, lineIndex, maskSource } from "./mask.js";
import { TABLE_REF } from "./python-orm.js";
import type {
  EntityFact,
  EntityField,
  EntityUseFact,
  ExtractInput,
  ExtractOutput,
  Extractor,
  Facts,
  Linker,
  SqlAlterAction,
  SqlDdlHint,
  SqlDdlOp,
  SqlUseHint,
  TableHint,
} from "./types.js";

/** One identifier, quoted or not; the name unquoted is group 1 of `NAME`, and `IDENT` adds an optional schema. */
const PART = String.raw`[\`"\[]?[A-Za-z_][\w$]*[\`"\]]?`;
const NAME = String.raw`[\`"\[]?([A-Za-z_][\w$]*)[\`"\]]?`;
const IDENT = String.raw`(?:${PART}\.)?${NAME}`;
const CONSTRAINT_START = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY|EXCLUDE|FULLTEXT|SPATIAL|LIKE|PERIOD)\b/i;
const TYPE_END =
  /\s+(?:NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|CONSTRAINT|GENERATED|COLLATE|AUTO_INCREMENT|AUTOINCREMENT|IDENTITY|ON|COMMENT|AS|ENCODE|CHARACTER\s+SET|USING)\b[\s\S]*$/i;
const REFERENCES = new RegExp(String.raw`\bREFERENCES\s+${IDENT}`, "i");
/** `[CONSTRAINT c] FOREIGN KEY [index] (cols) REFERENCES [schema.]table`: constraint = 1, cols = 2, table = 3. */
const FOREIGN_KEY = new RegExp(String.raw`(?:CONSTRAINT\s+${NAME}\s+)?FOREIGN\s+KEY\s*(?:${PART}\s*)?\(([^)]*)\)\s*REFERENCES\s+${IDENT}`, "i");

function unquoteIdent(raw: string): string {
  return raw.trim().replace(/^[`"[]|[`"\]]$/g, "");
}

const columnList = (raw: string) => raw.split(",").map(unquoteIdent).filter(Boolean);

/** A column definition (`name type [REFERENCES t] …`) as a field, or undefined when it is not one. */
function columnField(def: string): EntityField | undefined {
  const col = /^([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s+(.+)$/.exec(def);
  if (!col) return undefined;
  const type = (col[2] as string).replace(TYPE_END, "").trim();
  const field: EntityField = { name: unquoteIdent(col[1] as string), type: type || "unknown" };
  const ref = REFERENCES.exec(def);
  if (ref) field.relation = `${TABLE_REF}${ref[1]}`;
  return field;
}

/** Offset of the `;` ending the statement that runs from `from` (or of a blank line, or the end): quotes and parentheses skipped. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "`") {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return text.length;
      i = close;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === ";") return i;
    else if (depth === 0 && ch === "\n" && /^[ \t\r]*\n/.test(text.slice(i + 1, i + 80))) return i;
  }
  return text.length;
}

/** Split at top-level commas (outside parentheses and quotes). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "`") {
      const close = text.indexOf(ch, i + 1);
      i = close === -1 ? text.length : close;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** One `ALTER TABLE` action (whitespace-normalized) as a replayable action, or undefined when it does not change fields. */
function alterAction(def: string): SqlAlterAction | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^ADD\s+(.*)$/i.exec(def))) {
    const rest = m[1] as string;
    const fk = FOREIGN_KEY.exec(rest);
    if (fk) {
      const action: SqlAlterAction = { action: "add-fk", columns: columnList(fk[2] as string), table: fk[3] as string };
      if (fk[1]) action.constraint = fk[1];
      return action;
    }
    const col = /^COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(.*)$/i.exec(rest);
    if (!col && CONSTRAINT_START.test(rest)) return undefined;
    const field = columnField(col ? (col[1] as string) : rest.replace(/^IF\s+NOT\s+EXISTS\s+/i, ""));
    return field ? { action: "add-column", field } : undefined;
  }
  if ((m = /^DROP\s+(.*)$/i.exec(def))) {
    const rest = m[1] as string;
    const constraint = new RegExp(String.raw`^(?:CONSTRAINT|FOREIGN\s+KEY)\s+(?:IF\s+EXISTS\s+)?${NAME}`, "i").exec(rest);
    if (constraint) return { action: "drop-constraint", constraint: constraint[1] as string };
    const col = /^COLUMN\s+(.*)$/i.exec(rest);
    if (!col && /^(?:PRIMARY|INDEX|KEY|CHECK|DEFAULT|PERIOD|SYSTEM|PARTITION)\b/i.test(rest)) return undefined;
    const name = new RegExp(String.raw`^(?:IF\s+EXISTS\s+)?${NAME}`, "i").exec(col ? (col[1] as string) : rest);
    return name ? { action: "drop-column", column: name[1] as string } : undefined;
  }
  if ((m = /^RENAME\s+(.*)$/i.exec(def))) {
    const rest = m[1] as string;
    const table = new RegExp(String.raw`^(?:TO|AS)\s+${IDENT}`, "i").exec(rest);
    if (table) return { action: "rename-table", to: table[1] as string };
    if (/^(?:CONSTRAINT|INDEX|KEY)\b/i.test(rest)) return undefined;
    const col = new RegExp(String.raw`^(?:COLUMN\s+)?${NAME}\s+TO\s+${NAME}`, "i").exec(rest);
    return col ? { action: "rename-column", from: col[1] as string, to: col[2] as string } : undefined;
  }
  m = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?${NAME}\s+(?:SET\s+DATA\s+)?TYPE\s+(.+)$`, "i").exec(def);
  if (m) {
    const type = (m[2] as string).replace(TYPE_END, "").trim();
    return type ? { action: "set-type", column: m[1] as string, type } : undefined;
  }
  return undefined;
}

/** Up / down section markers of single-file migration tools: dbmate, goose, sql-migrate. */
const SECTION = /^[ \t]*--[ \t]*(?:migrate:(up|down)|\+goose[ \t]+(up|down)|\+migrate[ \t]+(up|down))\b/gim;

/** `[start, end)` offsets of the down sections of `text` (a down section runs to the next up marker or the end). */
function downSections(text: string): [number, number][] {
  const out: [number, number][] = [];
  let downAt: number | undefined;
  for (const m of text.matchAll(SECTION)) {
    const down = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase() === "down";
    if (down && downAt === undefined) downAt = m.index as number;
    else if (!down && downAt !== undefined) {
      out.push([downAt, m.index as number]);
      downAt = undefined;
    }
  }
  if (downAt !== undefined) out.push([downAt, text.length]);
  return out;
}

/** A down migration file: golang-migrate `1_x.down.sql`, Diesel `down.sql`, Flyway undo `U1__x.sql`. */
const DOWN_FILE = /(?:^|[/._-])down\.sql$|(?:^|\/)U\d[^/]*__[^/]*\.sql$/i;

function extractSchema(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text, { strings: true });
  const lineOf = lineIndex(text);
  const down = downSections(input.text);
  const inDown = (at: number) => down.some(([s, e]) => at >= s && at < e);
  const entities: EntityFact[] = [];
  const ops: { at: number; op: SqlDdlOp }[] = [];
  const CREATE = new RegExp(
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?((?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s*\(`,
    "gi",
  );
  for (const m of text.matchAll(CREATE)) {
    const at = m.index as number;
    if ((m[1] && /TEMP/i.test(m[1])) || inDown(at)) continue;
    const name = m[2] as string;
    const call = readArgs(text, at + m[0].length - 1);
    if (!call) continue;
    const fields: EntityField[] = [];
    const fks: { cols: string[]; table: string }[] = [];
    for (const arg of call.args) {
      const def = arg.raw.replace(/\s+/g, " ").trim();
      if (CONSTRAINT_START.test(def)) {
        const fk = FOREIGN_KEY.exec(def);
        if (fk) fks.push({ cols: columnList(fk[2] as string).map((c) => c.toLowerCase()), table: fk[3] as string });
        continue;
      }
      const field = columnField(def);
      if (field) fields.push(field);
    }
    for (const fk of fks) {
      for (const f of fields) if (fk.cols.includes(f.name.toLowerCase())) f.relation = `${TABLE_REF}${fk.table}`;
    }
    const line = lineOf(at);
    entities.push({ name, orm: "sql", file: input.rel, line, fields });
    ops.push({ at, op: { op: "create", table: name, line } });
  }
  const ALTER = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}[ \t]*\*?`, "gi");
  for (const m of text.matchAll(ALTER)) {
    const at = m.index as number;
    if (inDown(at)) continue;
    const from = at + m[0].length;
    const actions = splitTopLevel(text.slice(from, statementEnd(text, from)))
      .map(alterAction)
      .filter((a): a is SqlAlterAction => a !== undefined);
    if (actions.length) ops.push({ at, op: { op: "alter", table: m[1] as string, line: lineOf(at), actions } });
  }
  for (const m of text.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/gi)) {
    const at = m.index as number;
    if (inDown(at)) continue;
    const from = at + m[0].length;
    for (const item of splitTopLevel(text.slice(from, statementEnd(text, from)))) {
      const name = new RegExp(`^${IDENT}`).exec(item);
      if (name) ops.push({ at, op: { op: "drop", table: name[1] as string, line: lineOf(at) } });
    }
  }
  if (!entities.length && !ops.length) return {};
  ops.sort((a, b) => a.at - b.at);
  const hint: SqlDdlHint = { kind: "sql-ddl", file: input.rel, ops: ops.map((o) => o.op) };
  return entities.length ? { entities, hints: [hint] } : { hints: [hint] };
}

export const sqlSchemaExtractor: Extractor = {
  id: "sql-schema",
  applies: (input: ExtractInput) => input.rel.toLowerCase().endsWith(".sql") && !DOWN_FILE.test(input.rel),
  extract: extractSchema,
};

/**
 * Migration order of two `*.sql` paths: digit runs compare as numbers, so
 * Flyway `V2__a.sql` comes before `V10__b.sql`; zero-padded (drizzle-kit
 * `0002_x.sql`) and timestamped (Prisma `20240101120000_x/migration.sql`)
 * names keep their lexicographic order. Ties fall back to plain code-unit order.
 */
export function migrationOrder(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x === y) continue;
    if (i % 2 === 1) {
      const nx = x.replace(/^0+(?=\d)/, "");
      const ny = y.replace(/^0+(?=\d)/, "");
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return pa.length !== pb.length ? pa.length - pb.length : a < b ? -1 : a > b ? 1 : 0;
}

interface TableState {
  entity: EntityFact;
  /** Foreign-key constraints added by `ALTER TABLE … ADD CONSTRAINT c FOREIGN KEY`: lower-case name → lower-case columns. */
  constraints: Map<string, string[]>;
}

const lower = (s: string) => s.toLowerCase();

function applyAlter(t: TableState, a: SqlAlterAction, tables: Map<string, TableState>): void {
  const fields = t.entity.fields;
  const find = (col: string) => fields.find((f) => lower(f.name) === lower(col));
  switch (a.action) {
    case "add-column": {
      const at = fields.findIndex((f) => lower(f.name) === lower(a.field.name));
      if (at === -1) fields.push({ ...a.field });
      else fields[at] = { ...a.field };
      return;
    }
    case "drop-column":
      t.entity.fields = fields.filter((f) => lower(f.name) !== lower(a.column));
      for (const [name, cols] of t.constraints) if (cols.includes(lower(a.column))) t.constraints.delete(name);
      return;
    case "rename-column": {
      const f = find(a.from);
      if (f) f.name = a.to;
      for (const cols of t.constraints.values()) for (let i = 0; i < cols.length; i++) if (cols[i] === lower(a.from)) cols[i] = lower(a.to);
      return;
    }
    case "set-type": {
      const f = find(a.column);
      if (f) f.type = a.type;
      return;
    }
    case "add-fk":
      for (const col of a.columns) {
        const f = find(col);
        if (f) f.relation = `${TABLE_REF}${a.table}`;
      }
      if (a.constraint) t.constraints.set(lower(a.constraint), a.columns.map(lower));
      return;
    case "drop-constraint": {
      const cols = t.constraints.get(lower(a.constraint));
      if (!cols) return;
      for (const f of fields) if (cols.includes(lower(f.name))) delete f.relation;
      t.constraints.delete(lower(a.constraint));
      return;
    }
    case "rename-table": {
      const from = t.entity.name;
      tables.delete(lower(from));
      t.entity.name = a.to;
      tables.set(lower(a.to), t);
      // Foreign keys follow the table they reference.
      for (const other of tables.values()) {
        for (const f of other.entity.fields) if (f.relation && lower(f.relation) === lower(`${TABLE_REF}${from}`)) f.relation = `${TABLE_REF}${a.to}`;
      }
      return;
    }
  }
}

/**
 * Migrations → one SQL entity per table. Replays every file's DDL statements
 * (`SqlDdlHint`) in `migrationOrder` of the files, then file order: a
 * `CREATE TABLE` replaces the table (its entity fact is the citation), `ALTER
 * TABLE` actions change its fields, `DROP TABLE` removes it. SQL entities of
 * a superseded or dropped `CREATE TABLE` are dropped; other entities are
 * untouched. Runs before `orm-relations`, which settles the relation targets.
 */
export const sqlMigrationLinker: Linker = {
  id: "sql-migrations",
  link(facts: Facts, ctx): Facts {
    const ddl = ctx.hints.filter((h): h is SqlDdlHint => h.kind === "sql-ddl");
    if (!ddl.length) return facts;
    const key = (file: string, line: number, name: string) => `${file}\u0000${line}\u0000${lower(name)}`;
    const created = new Map<string, EntityFact[]>();
    const others: EntityFact[] = [];
    for (const e of facts.entities) {
      if (e.orm !== "sql") {
        others.push(e);
        continue;
      }
      const k = key(e.file, e.line, e.name);
      const list = created.get(k);
      if (list) list.push(e);
      else created.set(k, [e]);
    }
    const tables = new Map<string, TableState>();
    for (const hint of [...ddl].sort((a, b) => migrationOrder(a.file, b.file))) {
      for (const op of hint.ops) {
        if (op.op === "create") {
          const e = created.get(key(hint.file, op.line, op.table))?.shift();
          if (e) tables.set(lower(e.name), { entity: { ...e, fields: e.fields.map((f) => ({ ...f })) }, constraints: new Map() });
        } else if (op.op === "drop") tables.delete(lower(op.table));
        else {
          const t = tables.get(lower(op.table));
          if (t) for (const a of op.actions) applyAlter(t, a, tables);
        }
      }
    }
    const unreplayed = [...created.values()].flat();
    return { ...facts, entities: [...others, ...unreplayed, ...[...tables.values()].map((t) => t.entity)] };
  },
};

/** Statements a literal may hold, and the op each implies. */
const STATEMENTS: { re: RegExp; op: "read" | "write" }[] = [
  { re: new RegExp(String.raw`\b(INSERT\s+(?:IGNORE\s+)?INTO)\s+${IDENT}`, "gi"), op: "write" },
  { re: new RegExp(String.raw`\b(UPDATE)\s+${IDENT}\s+SET\b`, "gi"), op: "write" },
  { re: new RegExp(String.raw`\b(DELETE\s+FROM)\s+${IDENT}`, "gi"), op: "write" },
  { re: new RegExp(String.raw`\b(SELECT)\b[^'"\x60;]{0,400}?\bFROM\s+${IDENT}`, "gi"), op: "read" },
  { re: new RegExp(String.raw`\b(JOIN)\s+${IDENT}`, "gi"), op: "read" },
];

/** Code files whose string literals may hold SQL: every language mask.ts knows, except SQL and config files. */
function isCode(rel: string): boolean {
  const syntax = commentSyntaxFor(rel);
  return syntax === "js" || syntax === "python" || (syntax === "c" && !/\.(?:prisma|proto|graphql|gql)$/i.test(rel));
}

function extractLiterals(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text);
  const skeleton = maskSource(input.rel, input.text, { strings: true });
  // Inside a string: the character is blanked in the skeleton but not in the text.
  const inString = (i: number) => skeleton[i] === " " && text[i] !== " " && text[i] !== undefined;
  const lineOf = lineIndex(text);
  const hints: SqlUseHint[] = [];
  for (const { re, op } of STATEMENTS) {
    for (const m of text.matchAll(re)) {
      const at = m.index as number;
      const tableAt = at + m[0].lastIndexOf(m[2] as string);
      if (!inString(at) || !inString(tableAt)) continue;
      const keyword = m[1] as string;
      if (keyword !== keyword.toUpperCase()) {
        // Lower case only at the very start of the literal.
        let k = at - 1;
        while (k >= 0 && /\s/.test(text[k] as string)) k--;
        if (k >= 0 && inString(k)) continue;
      }
      if (op === "read" && keyword.toUpperCase() === "JOIN" && !/\bSELECT\b/i.test(text.slice(Math.max(0, at - 400), at))) continue;
      hints.push({ kind: "sql-use", table: m[2] as string, op, file: input.rel, line: lineOf(at) });
    }
  }
  return hints.length ? { hints } : {};
}

export const sqlLiteralExtractor: Extractor = {
  id: "sql-literals",
  applies: (input: ExtractInput) => isCode(input.rel) && /\b(?:INSERT|UPDATE|DELETE|SELECT|insert|update|delete|select)\b/.test(input.text),
  extract: extractLiterals,
};

/**
 * SQL literals → entity uses, for declared tables only: a `CREATE TABLE`
 * entity of that name (case-insensitive), else the ORM entity whose table it
 * is (`TableHint`). Literals naming an undeclared table are dropped.
 */
export const sqlUseLinker: Linker = {
  id: "sql-uses",
  link(facts: Facts, ctx): Facts {
    const uses = ctx.hints.filter((h): h is SqlUseHint => h.kind === "sql-use");
    if (!uses.length) return facts;
    const byTable = new Map<string, string>();
    for (const e of facts.entities) if (e.orm === "sql" && !byTable.has(e.name.toLowerCase())) byTable.set(e.name.toLowerCase(), e.name);
    const tableHints = ctx.hints
      .filter((h): h is TableHint => h.kind === "table")
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    for (const h of tableHints) if (!byTable.has(h.table.toLowerCase())) byTable.set(h.table.toLowerCase(), h.entity);
    const added: EntityUseFact[] = [];
    for (const u of uses) {
      const entity = byTable.get(u.table.toLowerCase());
      if (entity) added.push({ entity, file: u.file, line: u.line, op: u.op });
    }
    return added.length ? { ...facts, entityUses: [...facts.entityUses, ...added] } : facts;
  },
};
