// Python ORMs: SQLAlchemy and Django models (entities), and their uses.
//
// SQLAlchemy entities: declarative classes — `__tablename__`, or a declarative
// base (`Base`, `db.Model`, a `declarative_base()` result, a `DeclarativeBase`
// subclass) — with `Column(…)` / `mapped_column(…)` / `Mapped[…]` fields;
// `relationship("X")` and `ForeignKey("x.id")` are relations. Abstract classes
// are skipped. Each entity leaves a `TableHint` (its table) so foreign keys and
// SQL literals resolve to it.
//
// Django entities: `class X(models.Model)` (or a model class of the same
// file), `name = models.XField(…)` fields; `ForeignKey(X)` / `"app.X"` /
// `ManyToManyField` / `OneToOneField` are relations. Abstract models are
// skipped as entities but still count as bases.
//
// Uses: Django `X.objects.filter/get/all/…` read, `.create/.update/.delete/
// .bulk_create/…` write (a write anywhere on the chain wins); SQLAlchemy
// `session.query(X)` / `select(X)` / `session.get(X, …)` / `X.query.…` read,
// `session.add(X(…))` / `insert(X)` / `update(X)` / `delete(X)` write. Uses
// name the class as written; the `entity-uses` linker keeps only declared ones.

import { type Arg, readArgs } from "./js.js";
import { lineIndex, maskSource } from "./mask.js";
import { importsPyModule, isPython, kwarg, positional, pyClasses, pyDotted, pyImports, pyLiteral } from "./py.js";
import type { EntityFact, EntityField, EntityUseFact, ExtractInput, ExtractOutput, Extractor, Facts, Linker, RepoContext, TableHint } from "./types.js";

/** Prefix of a provisional relation naming a table (`ForeignKey("users.id")`), settled by the `orm-relations` linker. */
export const TABLE_REF = "@table:";

const SQLALCHEMY_DEPS = ["sqlalchemy", "flask-sqlalchemy"];

function lastName(dotted: string): string {
  return dotted.slice(dotted.lastIndexOf(".") + 1);
}

/** `CamelCase` → `camel_case` (Flask-SQLAlchemy's default table name). */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** The callee of a call expression (`db.Column(` → `db.Column`), with the `(` offset relative to `raw`. */
function callee(raw: string): { name: string; open: number } | undefined {
  const m = /^([A-Za-z_][\w.]*)\s*\(/.exec(raw);
  return m ? { name: (m[1] as string).replace(/\s+/g, ""), open: m[0].length - 1 } : undefined;
}

/** `Mapped[Optional["User"]]` → `User?`, `Mapped[List["OrderItem"]]` → `OrderItem[]`, `Mapped[int]` → `int`. */
function mappedType(annotation: string): { type: string; target: string } | undefined {
  const m = /^(?:[\w.]*\.)?Mapped\s*\[([\s\S]*)\]$/.exec(annotation.trim());
  if (!m) return undefined;
  let inner = (m[1] as string).replace(/["']/g, "").replace(/\s+/g, "");
  let suffix = "";
  const opt = /^(?:typing\.)?Optional\[(.*)\]$/.exec(inner) ?? /^(.*)\|None$/.exec(inner);
  if (opt) {
    inner = opt[1] as string;
    suffix = "?";
  }
  const list = /^(?:typing\.)?(?:List|list|Set|set)\[(.*)\]$/.exec(inner);
  if (list) {
    inner = list[1] as string;
    suffix = "[]";
  }
  const target = lastName(inner);
  return { type: `${target}${suffix}`, target };
}

/** One `name(: annotation)? (= value)?` statement of a class body. */
interface Stmt {
  name: string;
  annotation?: string;
  value?: string;
  /** Offset of `value` in the file. */
  valueAt: number;
}

function statement(text: string, at: number): Stmt | undefined {
  const m = /^([A-Za-z_]\w*)[ \t]*(?::[ \t]*([^=\n]+?))?[ \t]*(?:=(?!=)[ \t]*|$)/m.exec(text.slice(at, at + 400));
  if (!m) return undefined;
  const valueAt = at + m[0].length;
  const hasValue = /=\s*$/.test(m[0]);
  if (!hasValue && m[2] === undefined) return undefined;
  let value: string | undefined;
  if (hasValue) {
    const c = callee(text.slice(valueAt, valueAt + 200));
    if (c) {
      const call = readArgs(text, valueAt + c.open);
      value = call ? text.slice(valueAt, call.end) : undefined;
    } else value = /^[^\n]*/.exec(text.slice(valueAt))?.[0].trim();
  }
  return { name: m[1] as string, annotation: m[2]?.trim(), value, valueAt };
}

function callArgs(text: string, stmt: Stmt): { name: string; args: Arg[] } | undefined {
  if (!stmt.value) return undefined;
  const c = callee(stmt.value);
  if (!c) return undefined;
  const call = readArgs(text, stmt.valueAt + c.open);
  return call ? { name: c.name, args: call.args } : undefined;
}

/** The Python views of a file: `text` (comments blanked) and `skeleton` (strings blanked too). */
function pyViews(input: ExtractInput) {
  const text = maskSource(input.rel, input.text);
  return { text, skeleton: maskSource(input.rel, input.text, { strings: true }), lineOf: lineIndex(text) };
}

// ---------------------------------------------------------------- SQLAlchemy entities

const COLUMN_FNS = new Set(["Column", "mapped_column"]);
const RELATIONSHIP_FNS = new Set(["relationship", "relation"]);

function extractSqlalchemy(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = pyViews(input);
  const classes = pyClasses(skeleton, (open) => readArgs(text, open)?.args);
  if (!classes.length) return {};
  // Declarative bases: `Base = declarative_base()`, `class Base(DeclarativeBase)`, Flask-SQLAlchemy `db.Model`.
  const bases = new Set(["Base", "db.Model", "Model"]);
  for (const m of skeleton.matchAll(/^([A-Za-z_]\w*)\s*=\s*(?:[\w.]+\.)?(?:declarative_base|as_declarative)\s*\(/gm)) bases.add(m[1] as string);
  const baseClasses = new Set<string>();
  for (const c of classes) {
    if (c.bases.some((b) => /^(?:[\w.]+\.)?(?:DeclarativeBase|DeclarativeBaseNoMeta|DeclarativeMeta)$/.test(b.raw))) {
      bases.add(c.name);
      baseClasses.add(c.name);
    }
  }
  const entities: EntityFact[] = [];
  const hints: TableHint[] = [];
  for (const cls of classes) {
    if (baseClasses.has(cls.name)) continue;
    let table: string | undefined;
    let abstract = false;
    const fields: EntityField[] = [];
    for (const at of cls.statements) {
      const st = statement(text, at);
      if (!st) continue;
      if (st.name === "__tablename__") table = pyLiteral(st.value);
      if (st.name === "__abstract__" && st.value === "True") abstract = true;
      if (st.name.startsWith("__")) continue;
      const mapped = st.annotation ? mappedType(st.annotation) : undefined;
      const call = callArgs(text, st);
      const fn = call ? lastName(call.name) : undefined;
      if (fn && RELATIONSHIP_FNS.has(fn)) {
        const first = positional(call?.args ?? [])[0] ?? kwarg(call?.args ?? [], "argument");
        const named = first ? (pyLiteral(first.raw) ?? pyDotted(first.raw)) : undefined;
        const target = named ? lastName(named) : mapped?.target;
        if (!target) continue;
        fields.push({ name: st.name, type: mapped?.type ?? target, relation: target });
        continue;
      }
      if (fn && COLUMN_FNS.has(fn)) {
        const args = call?.args ?? [];
        let type = mapped?.type;
        let relation: string | undefined;
        for (const a of positional(args)) {
          const fk = /^(?:[\w.]+\.)?ForeignKey\s*\(\s*(["'])([^"']+)\1/.exec(a.raw);
          if (fk) {
            const ref = fk[2] as string;
            relation = `${TABLE_REF}${ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : ref}`;
            continue;
          }
          const t = /^(?:[\w]+\.)*([A-Z]\w*)\b/.exec(a.raw);
          if (t && !type && pyLiteral(a.raw) === undefined) type = t[1] as string;
        }
        const field: EntityField = { name: st.name, type: type ?? "unknown" };
        if (relation) field.relation = relation;
        fields.push(field);
        continue;
      }
      if (mapped && st.value === undefined) fields.push({ name: st.name, type: mapped.type });
    }
    if (abstract) continue;
    const declarative = cls.bases.some((b) => bases.has(b.raw.replace(/\s+/g, "")));
    if (table === undefined && !(declarative && fields.length)) continue;
    const line = lineOf(cls.offset);
    entities.push({ name: cls.name, orm: "sqlalchemy", file: input.rel, line, fields });
    hints.push({ kind: "table", orm: "sqlalchemy", entity: cls.name, table: table ?? snake(cls.name), file: input.rel, line });
  }
  const out: ExtractOutput = {};
  if (entities.length) out.entities = entities;
  if (hints.length) out.hints = hints;
  return out;
}

export const sqlalchemyModelsExtractor: Extractor = {
  id: "sqlalchemy-models",
  applies(input: ExtractInput, ctx: RepoContext): boolean {
    if (!isPython(input.rel)) return false;
    const deps = ctx.depsFor(input.rel);
    return SQLALCHEMY_DEPS.some((d) => deps.has(d));
  },
  extract: extractSqlalchemy,
};

// ---------------------------------------------------------------- Django entities

const DJANGO_RELATIONS = new Set(["ForeignKey", "OneToOneField", "ManyToManyField"]);

/** The directory a Django app's models live in names its label: `shop/orders/models.py` → `orders`. */
function appLabel(rel: string): string {
  const parts = rel.split("/");
  parts.pop();
  if (parts[parts.length - 1] === "models") parts.pop();
  return parts[parts.length - 1] ?? "";
}

function extractDjangoModels(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = pyViews(input);
  const imports = pyImports(text);
  const modelsAlias = [...imports.entries()].find(([, imp]) => imp.module === "django.db" && imp.name === "models")?.[0];
  if (!modelsAlias) return {};
  const classes = pyClasses(skeleton, (open) => readArgs(text, open)?.args);
  const models = new Set<string>();
  const entities: EntityFact[] = [];
  const hints: TableHint[] = [];
  for (const cls of classes) {
    const isModel = cls.bases.some((b) => {
      const raw = b.raw.replace(/\s+/g, "");
      return raw === `${modelsAlias}.Model` || models.has(raw);
    });
    if (!isModel) continue;
    models.add(cls.name);
    const fields: EntityField[] = [];
    let abstract = false;
    let table: string | undefined;
    for (const at of cls.statements) {
      // `class Meta:` — abstract / db_table.
      if (/^class[ \t]+Meta\b/.test(skeleton.slice(at, at + 20))) {
        const meta = classes.find((c) => c.offset === at);
        for (const mat of meta?.statements ?? []) {
          const st = statement(text, mat);
          if (st?.name === "abstract" && st.value === "True") abstract = true;
          if (st?.name === "db_table") table = pyLiteral(st.value);
        }
        continue;
      }
      const st = statement(text, at);
      const call = st && callArgs(text, st);
      if (!st || !call) continue;
      const m = new RegExp(`^${modelsAlias}\\.([A-Z]\\w*)$`).exec(call.name);
      if (!m) continue;
      const type = m[1] as string;
      if (!type.endsWith("Field") && !DJANGO_RELATIONS.has(type)) continue;
      const field: EntityField = { name: st.name, type };
      if (DJANGO_RELATIONS.has(type)) {
        const to = positional(call.args)[0] ?? kwarg(call.args, "to");
        const raw = to ? (pyLiteral(to.raw) ?? pyDotted(to.raw)) : undefined;
        if (raw) {
          const name = raw === "self" ? cls.name : /AUTH_USER_MODEL$/.test(raw) ? "User" : lastName(raw);
          field.relation = name;
        }
      }
      fields.push(field);
    }
    if (abstract) continue;
    const line = lineOf(cls.offset);
    entities.push({ name: cls.name, orm: "django", file: input.rel, line, fields });
    const label = appLabel(input.rel);
    hints.push({
      kind: "table",
      orm: "django",
      entity: cls.name,
      table: table ?? `${label ? `${label}_` : ""}${cls.name.toLowerCase()}`,
      file: input.rel,
      line,
    });
  }
  const out: ExtractOutput = {};
  if (entities.length) out.entities = entities;
  if (hints.length) out.hints = hints;
  return out;
}

export const djangoModelsExtractor: Extractor = {
  id: "django-models",
  applies: (input: ExtractInput, ctx: RepoContext) => isPython(input.rel) && ctx.depsFor(input.rel).has("django"),
  extract: extractDjangoModels,
};

// ---------------------------------------------------------------- uses

const DJANGO_READ = [
  "all",
  "filter",
  "exclude",
  "get",
  "first",
  "last",
  "count",
  "exists",
  "values",
  "values_list",
  "order_by",
  "aggregate",
  "annotate",
  "select_related",
  "prefetch_related",
  "in_bulk",
  "iterator",
  "distinct",
  "only",
  "defer",
  "raw",
  "latest",
  "earliest",
  "aget",
  "afirst",
  "alast",
  "acount",
  "aexists",
];
const DJANGO_WRITE = ["create", "update", "delete", "bulk_create", "bulk_update", "get_or_create", "update_or_create", "acreate", "aupdate", "adelete"];
const DJANGO_OP = new Map<string, "read" | "write">([...DJANGO_READ.map((o) => [o, "read"] as const), ...DJANGO_WRITE.map((o) => [o, "write"] as const)]);

function extractDjangoUses(input: ExtractInput): ExtractOutput {
  const { skeleton, lineOf } = pyViews(input);
  const uses: EntityUseFact[] = [];
  const CALL = /(?<![\w.])([A-Z]\w*)\s*\.\s*objects\s*\.\s*([a-z_]+)\s*\(/g;
  for (const m of skeleton.matchAll(CALL)) {
    let op = DJANGO_OP.get(m[2] as string);
    if (!op) continue;
    // A write anywhere on the chain wins: `X.objects.filter(…).delete()`.
    let at = readArgs(skeleton, (m.index as number) + m[0].length - 1)?.end;
    while (at !== undefined && op === "read") {
      const chain = /^\s*\.\s*([a-z_]+)\s*\(/.exec(skeleton.slice(at, at + 200));
      if (!chain) break;
      if (DJANGO_OP.get(chain[1] as string) === "write") op = "write";
      at = readArgs(skeleton, at + chain[0].length - 1)?.end;
    }
    uses.push({ entity: m[1] as string, file: input.rel, line: lineOf(m.index as number), op });
  }
  return uses.length ? { entityUses: uses } : {};
}

export const djangoOrmExtractor: Extractor = {
  id: "django-orm",
  applies: (input: ExtractInput, ctx: RepoContext) => isPython(input.rel) && ctx.depsFor(input.rel).has("django"),
  extract: extractDjangoUses,
};

function extractSqlalchemyUses(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const { text, skeleton, lineOf } = pyViews(input);
  const uses: EntityUseFact[] = [];
  const push = (entity: string, offset: number, op: "read" | "write") => uses.push({ entity, file: input.rel, line: lineOf(offset), op });
  // A session-like receiver: `session`, `db.session`, `self.session`, `async_session`, `db`.
  const SESSION = String.raw`(?<![\w.])(?:self\.|db\.)?(?:\w*session\w*|db)`;
  for (const m of skeleton.matchAll(new RegExp(`${SESSION}\\s*\\.\\s*(query|get)\\s*\\(\\s*([A-Z]\\w*)\\b`, "gi"))) {
    if (!/^[A-Z]/.test(m[2] as string)) continue;
    push(m[2] as string, m.index as number, "read");
  }
  for (const m of skeleton.matchAll(new RegExp(`${SESSION}\\s*\\.\\s*(add|add_all|merge)\\s*\\(\\s*\\[?\\s*([A-Z]\\w*)\\s*\\(`, "gi"))) {
    if (!/^[A-Z]/.test(m[2] as string)) continue;
    push(m[2] as string, m.index as number, "write");
  }
  // Core constructs, only when they are SQLAlchemy's: imported from it, or `sa.` / `sqlalchemy.` qualified.
  const imports = pyImports(text);
  const fromSa = (name: string) => {
    const imp = imports.get(name);
    return !!imp && imp.name === name && /^sqlalchemy(?:\.|$)/.test(imp.module);
  };
  const saModules = [...imports.entries()].filter(([, imp]) => imp.name === undefined && imp.module === "sqlalchemy").map(([local]) => local);
  const CORE: [string, "read" | "write"][] = [
    ["select", "read"],
    ["insert", "write"],
    ["update", "write"],
    ["delete", "write"],
  ];
  for (const [fn, op] of CORE) {
    const alts = [...(fromSa(fn) ? [fn] : []), ...saModules.map((s) => `${s}\\s*\\.\\s*${fn}`)];
    if (!alts.length) continue;
    for (const m of skeleton.matchAll(new RegExp(`(?<![\\w.])(?:${alts.join("|")})\\s*\\(\\s*([A-Z]\\w*)\\b`, "g")))
      push(m[1] as string, m.index as number, op);
  }
  // Flask-SQLAlchemy: `Order.query.filter_by(…)`.
  if (ctx.depsFor(input.rel).has("flask-sqlalchemy")) {
    for (const m of skeleton.matchAll(/(?<![\w.])([A-Z]\w*)\s*\.\s*query\s*\.\s*[a-z_]+\s*\(/g)) push(m[1] as string, m.index as number, "read");
  }
  return uses.length ? { entityUses: uses } : {};
}

export const sqlalchemyOrmExtractor: Extractor = {
  id: "sqlalchemy-orm",
  applies(input: ExtractInput, ctx: RepoContext): boolean {
    if (!isPython(input.rel)) return false;
    const deps = ctx.depsFor(input.rel);
    return SQLALCHEMY_DEPS.some((d) => deps.has(d)) && (importsPyModule(input.text, "sqlalchemy") || /\bsession\b|\bdb\b/.test(input.text));
  },
  extract: extractSqlalchemyUses,
};

/**
 * Settle relations of the SQLAlchemy, Django and SQL entities: a relation
 * naming a class is kept when an entity of the same ORM declares it; a
 * provisional table reference (`ForeignKey("users.id")`, SQL `REFERENCES
 * users`) is resolved to the entity mapped to that table (`TableHint`s, and
 * SQL tables by name). Anything unresolved is dropped, like Prisma's.
 */
export const ormRelationLinker: Linker = {
  id: "orm-relations",
  link(facts: Facts, ctx): Facts {
    const ORMS = new Set(["sqlalchemy", "django", "sql"]);
    const names = new Map<string, Set<string>>();
    const tables = new Map<string, Map<string, string>>();
    const tableMap = (orm: string) => {
      let m = tables.get(orm);
      if (!m) tables.set(orm, (m = new Map()));
      return m;
    };
    for (const e of facts.entities) {
      if (!ORMS.has(e.orm)) continue;
      let set = names.get(e.orm);
      if (!set) names.set(e.orm, (set = new Set()));
      set.add(e.name);
      if (e.orm === "sql") tableMap("sql").set(e.name.toLowerCase(), e.name);
    }
    const sortedHints = ctx.hints
      .filter((h): h is TableHint => h.kind === "table")
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    for (const h of sortedHints) {
      const m = tableMap(h.orm);
      if (!m.has(h.table.toLowerCase())) m.set(h.table.toLowerCase(), h.entity);
    }
    const entities = facts.entities.map((e) => {
      if (!ORMS.has(e.orm)) return e;
      return {
        ...e,
        fields: e.fields.map((f) => {
          const { relation, ...rest } = f;
          if (!relation) return f;
          const resolved = relation.startsWith(TABLE_REF)
            ? tables.get(e.orm)?.get(relation.slice(TABLE_REF.length).replace(/^.*\./, "").toLowerCase())
            : names.get(e.orm)?.has(relation)
              ? relation
              : undefined;
          return resolved ? { ...rest, relation: resolved } : rest;
        }),
      };
    });
    return { ...facts, entities };
  },
};
