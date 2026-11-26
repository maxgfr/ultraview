import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { sqlLiteralExtractor, sqlSchemaExtractor } from "../src/extract/sql.js";
import { memoryContext } from "./helpers.js";

function factsOf(files: Record<string, string>) {
  return runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
}
const lines = (...l: string[]) => l.join("\n");

const MIGRATION = lines(
  "-- CREATE TABLE ghost (id int);",
  'CREATE TABLE IF NOT EXISTS "public"."users" (',
  "  id SERIAL PRIMARY KEY,",
  "  email varchar(255) NOT NULL DEFAULT 'a,b'",
  ");",
  "/* CREATE TABLE commented (id int); */",
  "create table orders (",
  "  id bigint generated always as identity,",
  "  user_id int references users (id) on delete cascade,",
  "  placed_at timestamp with time zone,",
  "  coupon_id int,",
  "  PRIMARY KEY (id),",
  "  CONSTRAINT fk_coupon FOREIGN KEY (coupon_id) REFERENCES coupons(id)",
  ");",
  "CREATE TEMP TABLE scratch (id int);",
  "INSERT INTO users (email) VALUES ('CREATE TABLE fake (id int)');",
);

describe("sql schema extractor", () => {
  it("reads CREATE TABLE columns and references, schema and quotes dropped", () => {
    const facts = factsOf({ "db/migrations/001_init.sql": MIGRATION });
    expect(
      facts.entities.map((e) => `${e.name}(${e.orm}):${e.line} ${e.fields.map((f) => `${f.name}:${f.type}${f.relation ? `->${f.relation}` : ""}`).join(" ")}`),
    ).toEqual(["users(sql):2 id:SERIAL email:varchar(255)", "orders(sql):7 id:bigint user_id:int->users placed_at:timestamp with time zone coupon_id:int"]);
  });

  it("keeps an ORM entity and a SQL table of the same name as two facts", () => {
    const facts = factsOf({
      "requirements.txt": "sqlalchemy\n",
      "schema.sql": "CREATE TABLE Order (id int);",
      "models.py": lines(
        "from sqlalchemy.orm import DeclarativeBase",
        "class Base(DeclarativeBase): pass",
        "class Order(Base):",
        '    __tablename__ = "orders"',
      ),
    });
    expect(facts.entities.map((e) => `${e.name} ${e.orm}`)).toEqual(["Order sqlalchemy", "Order sql"]);
  });

  describe("false-positive guards", () => {
    it("only reads .sql files: not markdown, not SQL in code", () => {
      const ctx = memoryContext({});
      expect(sqlSchemaExtractor.applies({ rel: "migrations/1.sql", text: "" }, ctx)).toBe(true);
      expect(sqlSchemaExtractor.applies({ rel: "docs/schema.md", text: "" }, ctx)).toBe(false);
      expect(factsOf({ "docs/schema.md": MIGRATION, "app/db.py": `SQL = """${MIGRATION}"""` }).entities).toEqual([]);
    });
  });
});

describe("sql literal uses", () => {
  const SCHEMA = { "migrations/001.sql": "CREATE TABLE orders (id int);\nCREATE TABLE audit_log (id int);\n" };

  it("reads INSERT / UPDATE / DELETE / SELECT / JOIN literals on declared tables, in any language", () => {
    const facts = factsOf({
      ...SCHEMA,
      "app/db.py": lines(
        'cur.execute("SELECT id FROM orders WHERE id = %s", (1,))',
        'cur.execute("""',
        "    UPDATE orders SET status = 'paid'",
        '""")',
        "cur.execute(f\"insert into audit_log (msg) values ('{m}')\")",
      ),
      "src/repo.ts": lines("await sql`DELETE FROM orders WHERE id = ${id}`;", 'await db.query("SELECT a.id FROM audit_log a JOIN orders o ON o.id = a.id");'),
      "internal/store.go": 'db.Exec("INSERT INTO public.orders (id) VALUES ($1)", id)',
    });
    expect(facts.entityUses.map((u) => `${u.entity} ${u.op} ${u.file}:${u.line}`)).toEqual([
      "orders read app/db.py:1",
      "orders write app/db.py:3",
      "audit_log write app/db.py:5",
      "orders write internal/store.go:1",
      "orders write src/repo.ts:1",
      "audit_log read src/repo.ts:2",
      "orders read src/repo.ts:2",
    ]);
  });

  it("resolves a literal to the ORM entity mapped to that table", () => {
    const facts = factsOf({
      "requirements.txt": "sqlalchemy\n",
      "models.py": lines(
        "from sqlalchemy.orm import DeclarativeBase",
        "class Base(DeclarativeBase): pass",
        "class Order(Base):",
        '    __tablename__ = "orders"',
      ),
      "raw.py": 'q = "SELECT * FROM orders"',
    });
    expect(facts.entityUses).toEqual([{ entity: "Order", file: "raw.py", line: 1, op: "read" }]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, prose in strings, undeclared tables, identifiers and test files", () => {
      const facts = factsOf({
        ...SCHEMA,
        "app/a.py": lines(
          '# cur.execute("DELETE FROM orders")',
          'log.info("could not update orders set now")',
          'log.info("Failed to select from orders")',
          'cur.execute("SELECT * FROM ghosts")',
          "select_from_orders = 1",
        ),
        "tests/test_a.py": 'cur.execute("DELETE FROM orders")',
      });
      expect(facts.entityUses).toEqual([]);
    });

    it("does not read SQL or config files as code", () => {
      const ctx = memoryContext({});
      expect(sqlLiteralExtractor.applies({ rel: "seed.sql", text: "INSERT INTO orders" }, ctx)).toBe(false);
      expect(sqlLiteralExtractor.applies({ rel: "a.yml", text: "q: 'SELECT * FROM orders'" }, ctx)).toBe(false);
    });
  });
});
