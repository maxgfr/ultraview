// SQL: entities from `CREATE TABLE` statements in `*.sql` files (migrations
// included), and entity uses from SQL statement literals in code.
//
// Schema: `CREATE TABLE [IF NOT EXISTS] [schema.]name (…)` — each column is a
// field (`name type`), an inline `REFERENCES other` or a table-level
// `FOREIGN KEY (col) REFERENCES other` makes it a relation (settled by the
// `orm-relations` linker). Temporary tables are not data models. The entity's
// name is the table name as written, schema and quotes dropped.
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
import type { EntityFact, EntityField, EntityUseFact, ExtractInput, ExtractOutput, Extractor, Facts, Linker, SqlUseHint, TableHint } from "./types.js";

const IDENT = String.raw`(?:[\`"\[]?[A-Za-z_][\w$]*[\`"\]]?\.)?[\`"\[]?([A-Za-z_][\w$]*)[\`"\]]?`;
const CONSTRAINT_START = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY|EXCLUDE|FULLTEXT|SPATIAL|LIKE|PERIOD)\b/i;
const TYPE_END =
  /\s+(?:NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|CONSTRAINT|GENERATED|COLLATE|AUTO_INCREMENT|AUTOINCREMENT|IDENTITY|ON|COMMENT|AS|ENCODE|CHARACTER\s+SET)\b[\s\S]*$/i;

function unquoteIdent(raw: string): string {
  return raw.trim().replace(/^[`"[]|[`"\]]$/g, "");
}

function extractSchema(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text, { strings: true });
  const lineOf = lineIndex(text);
  const entities: EntityFact[] = [];
  const CREATE = new RegExp(
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?((?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s*\(`,
    "gi",
  );
  for (const m of text.matchAll(CREATE)) {
    if (m[1] && /TEMP/i.test(m[1])) continue;
    const name = m[2] as string;
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call) continue;
    const fields: EntityField[] = [];
    const fks: { cols: string[]; table: string }[] = [];
    for (const arg of call.args) {
      const def = arg.raw.replace(/\s+/g, " ").trim();
      if (CONSTRAINT_START.test(def)) {
        const fk = new RegExp(String.raw`FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+${IDENT}`, "i").exec(def);
        if (fk) fks.push({ cols: (fk[1] as string).split(",").map(unquoteIdent), table: fk[2] as string });
        continue;
      }
      const col = /^([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s+(.+)$/.exec(def);
      if (!col) continue;
      const type = (col[2] as string).replace(TYPE_END, "").trim();
      const field: EntityField = { name: unquoteIdent(col[1] as string), type: type || "unknown" };
      const ref = new RegExp(String.raw`\bREFERENCES\s+${IDENT}`, "i").exec(def);
      if (ref) field.relation = `${TABLE_REF}${ref[1]}`;
      fields.push(field);
    }
    for (const fk of fks) {
      for (const f of fields) if (fk.cols.includes(f.name)) f.relation = `${TABLE_REF}${fk.table}`;
    }
    entities.push({ name, orm: "sql", file: input.rel, line: lineOf(m.index as number), fields });
  }
  return entities.length ? { entities } : {};
}

export const sqlSchemaExtractor: Extractor = {
  id: "sql-schema",
  applies: (input: ExtractInput) => input.rel.toLowerCase().endsWith(".sql"),
  extract: extractSchema,
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
