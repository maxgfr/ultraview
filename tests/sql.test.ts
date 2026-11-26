import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { migrationOrder, sqlLiteralExtractor, sqlSchemaExtractor } from "../src/extract/sql.js";
import { memoryContext } from "./helpers.js";

function factsOf(files: Record<string, string>) {
  return runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
}
const lines = (...l: string[]) => l.join("\n");
const show = (facts: ReturnType<typeof factsOf>) =>
  facts.entities.map((e) => `${e.name} ${e.file}:${e.line} ${e.fields.map((f) => `${f.name}:${f.type}${f.relation ? `->${f.relation}` : ""}`).join(" ")}`);

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

describe("sql migrations", () => {
  it("reads drizzle-kit ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY as relations", () => {
    const facts = factsOf({
      "drizzle/0000_init.sql": lines(
        'CREATE TABLE IF NOT EXISTS "app_user" (',
        '\t"id" text PRIMARY KEY NOT NULL,',
        '\t"email" text NOT NULL',
        ");",
        "--> statement-breakpoint",
        'CREATE TABLE IF NOT EXISTS "app_post" (',
        '\t"id" serial PRIMARY KEY NOT NULL,',
        '\t"authorId" text NOT NULL,',
        '\t"editorId" text',
        ");",
        "--> statement-breakpoint",
        'ALTER TABLE "app_post" ADD CONSTRAINT "app_post_authorId_app_user_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;',
      ),
      "drizzle/0001_editor.sql": lines(
        "DO $$ BEGIN",
        ' ALTER TABLE "app_post" ADD CONSTRAINT "app_post_editorId_app_user_id_fk" FOREIGN KEY ("editorId") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;',
        "EXCEPTION",
        " WHEN duplicate_object THEN null;",
        "END $$;",
      ),
    });
    expect(show(facts)).toEqual([
      "app_user drizzle/0000_init.sql:1 id:text email:text",
      "app_post drizzle/0000_init.sql:6 id:serial authorId:text->app_user editorId:text->app_user",
    ]);
  });

  it("reads ALTER TABLE foreign keys with ONLY, IF EXISTS, schemas and every quoting style", () => {
    const facts = factsOf({
      "db/structure.sql": lines(
        "CREATE TABLE public.users (id bigint NOT NULL);",
        "CREATE TABLE public.posts (id bigint NOT NULL, user_id bigint, reviewer_id bigint, topic_id bigint);",
        "CREATE TABLE `topics` (`id` int, `owner_id` int);",
        "CREATE TABLE [dbo].[tags] ([id] int, [post_id] int);",
        "CREATE TABLE notes (id integer);",
        "ALTER TABLE ONLY public.posts",
        "    ADD CONSTRAINT fk_rails_5b5ddfd518 FOREIGN KEY (user_id) REFERENCES public.users(id);",
        "ALTER TABLE IF EXISTS ONLY posts ADD FOREIGN KEY (reviewer_id) REFERENCES users;",
        "ALTER TABLE `topics` ADD CONSTRAINT `topics_owner_fk` FOREIGN KEY `topics_owner_idx` (`owner_id`) REFERENCES `users` (`id`);",
        "ALTER TABLE [dbo].[tags] ADD CONSTRAINT [FK_tags_posts] FOREIGN KEY ([post_id]) REFERENCES [dbo].[posts] ([id]);",
        "ALTER TABLE notes ADD COLUMN author_id integer REFERENCES users(id);",
      ),
    });
    expect(show(facts)).toEqual([
      "users db/structure.sql:1 id:bigint",
      "posts db/structure.sql:2 id:bigint user_id:bigint->users reviewer_id:bigint->users topic_id:bigint",
      "topics db/structure.sql:3 id:int owner_id:int->users",
      "tags db/structure.sql:4 id:int post_id:int->posts",
      "notes db/structure.sql:5 id:integer author_id:integer->users",
    ]);
  });

  it("reads table-level foreign keys in CREATE TABLE, composite ones on every column", () => {
    const facts = factsOf({
      "schema.sql": lines(
        "CREATE TABLE accounts (tenant_id int, id int, PRIMARY KEY (tenant_id, id));",
        "CREATE TABLE invoices (",
        "  id int,",
        "  tenant_id int,",
        "  account_id int,",
        "  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)",
        ");",
        "CREATE TABLE payments (id int, tenant_id int, account_id int, CONSTRAINT payments_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id));",
        "CREATE TABLE refunds (id int, tenant_id int, account_id int);",
        "ALTER TABLE refunds ADD CONSTRAINT refunds_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id);",
      ),
    });
    expect(show(facts)).toEqual([
      "accounts schema.sql:1 tenant_id:int id:int",
      "invoices schema.sql:2 id:int tenant_id:int->accounts account_id:int->accounts",
      "payments schema.sql:8 id:int tenant_id:int->accounts account_id:int->accounts",
      "refunds schema.sql:9 id:int tenant_id:int->accounts account_id:int->accounts",
    ]);
  });

  it("keeps one entity per table across migrations, cited at its latest CREATE TABLE", () => {
    const facts = factsOf({
      "drizzle/0000_init.sql": 'CREATE TABLE "app_user" ("id" text, "name" text);\nCREATE TABLE "app_team" ("id" text);',
      "drizzle/0001_rebuild.sql": lines('DROP TABLE "app_user";--> statement-breakpoint', 'CREATE TABLE "app_user" ("id" text, "email" text);'),
      "drizzle/0002_reconcile.sql": lines(
        "-- reconcile",
        'CREATE TABLE IF NOT EXISTS "public"."app_user" (',
        '  "id" text,',
        '  "email" text,',
        '  "teamId" text',
        ");",
      ),
    });
    expect(show(facts)).toEqual(["app_team drizzle/0000_init.sql:2 id:text", "app_user drizzle/0002_reconcile.sql:2 id:text email:text teamId:text"]);
    expect(facts.entities.find((e) => e.name === "app_user")?.end).toBe(6);
  });

  it("keeps one entity when a file drops and re-creates a table", () => {
    const facts = factsOf({ "schema.sql": "CREATE TABLE t (a int);\nDROP TABLE IF EXISTS t;\nCREATE TABLE t (b int);\n" });
    expect(show(facts)).toEqual(["t schema.sql:3 b:int"]);
  });

  it("applies later ADD / DROP / RENAME COLUMN and type changes", () => {
    const facts = factsOf({
      "migrations/0001_init.sql": lines("CREATE TABLE users (id int, name text, legacy text);", "CREATE TABLE orders (id int, total int, buyer int);"),
      "migrations/0002_change.sql": lines(
        'ALTER TABLE "users" ADD COLUMN "email" varchar(255) NOT NULL, ADD COLUMN IF NOT EXISTS age int, DROP COLUMN IF EXISTS legacy;',
        "ALTER TABLE users RENAME COLUMN name TO full_name;",
        'ALTER TABLE "orders" ALTER COLUMN "total" SET DATA TYPE numeric(10, 2);',
        "ALTER TABLE orders ALTER COLUMN id TYPE bigint USING id::bigint;",
        "ALTER TABLE orders RENAME buyer TO buyer_id;",
        "ALTER TABLE orders ADD CONSTRAINT orders_buyer_fk FOREIGN KEY (buyer_id) REFERENCES users(id);",
        "ALTER TABLE orders DROP total;",
      ),
    });
    expect(show(facts)).toEqual([
      "users migrations/0001_init.sql:1 id:int full_name:text email:varchar(255) age:int",
      "orders migrations/0001_init.sql:2 id:bigint buyer_id:int->users",
    ]);
  });

  it("removes a dropped table, and the relation of a dropped constraint", () => {
    const facts = factsOf({
      "prisma/migrations/20240101000000_init/migration.sql": lines(
        'CREATE TABLE "User" ("id" TEXT NOT NULL);',
        'CREATE TABLE "Post" ("id" TEXT NOT NULL, "authorId" TEXT NOT NULL);',
        'CREATE TABLE "Draft" ("id" TEXT NOT NULL);',
        'CREATE TABLE "Tag" ("id" TEXT NOT NULL);',
        'ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      ),
      "prisma/migrations/20240202000000_cleanup/migration.sql": lines(
        'ALTER TABLE "Post" DROP CONSTRAINT "Post_authorId_fkey";',
        'DROP TABLE "Draft", "Tag" CASCADE;',
      ),
    });
    expect(show(facts)).toEqual([
      "User prisma/migrations/20240101000000_init/migration.sql:1 id:TEXT",
      "Post prisma/migrations/20240101000000_init/migration.sql:2 id:TEXT authorId:TEXT",
    ]);
  });

  it("follows a table rename, as in SQLite table rebuilds", () => {
    const facts = factsOf({
      "migrations/0001_init.sql": lines('CREATE TABLE "User" ("id" TEXT);', 'CREATE TABLE "Post" ("id" TEXT, "authorId" TEXT REFERENCES "User" ("id"));'),
      "migrations/0002_rebuild.sql": lines(
        "PRAGMA foreign_keys=OFF;",
        'CREATE TABLE "new_User" ("id" TEXT, "name" TEXT);',
        'INSERT INTO "new_User" ("id") SELECT "id" FROM "User";',
        'DROP TABLE "User";',
        'ALTER TABLE "new_User" RENAME TO "User";',
        "CREATE TABLE legacy (id int);",
        "ALTER TABLE legacy RENAME TO archive;",
      ),
    });
    expect(show(facts)).toEqual([
      "Post migrations/0001_init.sql:2 id:TEXT authorId:TEXT->User",
      "User migrations/0002_rebuild.sql:2 id:TEXT name:TEXT",
      "archive migrations/0002_rebuild.sql:6 id:int",
    ]);
  });

  it("replays files in migration order: numbers compare as numbers", () => {
    expect(["V10__b.sql", "V2__a.sql", "V1__init.sql"].sort(migrationOrder)).toEqual(["V1__init.sql", "V2__a.sql", "V10__b.sql"]);
    expect(["drizzle/0010_b.sql", "drizzle/0002_a.sql"].sort(migrationOrder)).toEqual(["drizzle/0002_a.sql", "drizzle/0010_b.sql"]);
    const facts = factsOf({
      "db/V1__init.sql": "CREATE TABLE t (a int);",
      "db/V2__add.sql": "ALTER TABLE t ADD COLUMN b int;",
      "db/V10__drop.sql": "ALTER TABLE t DROP COLUMN b;",
    });
    expect(show(facts)).toEqual(["t db/V1__init.sql:1 a:int"]);
  });

  it("skips down migrations: down files and down sections", () => {
    const facts = factsOf({
      "migrations/000001_users.up.sql": "CREATE TABLE users (id int);",
      "migrations/000001_users.down.sql": "DROP TABLE users;",
      "migrations/2024_orders/up.sql": "CREATE TABLE orders (id int);",
      "migrations/2024_orders/down.sql": "DROP TABLE orders;",
      "db/migrations/20240301_items.sql": lines(
        "-- migrate:up",
        "CREATE TABLE items (id int);",
        "-- migrate:down",
        "DROP TABLE items;",
        "CREATE TABLE ghost (id int);",
      ),
      "db/goose/00002_carts.sql": lines("-- +goose Up", "CREATE TABLE carts (id int);", "-- +goose Down", "DROP TABLE carts;"),
    });
    expect(show(facts).map((s) => s.split(" ")[0])).toEqual(["carts", "items", "users", "orders"]);
  });

  describe("false-positive guards", () => {
    it("ignores DDL in comments and strings, constraints that are not foreign keys, and unknown tables", () => {
      const facts = factsOf({
        "schema.sql": lines(
          "CREATE TABLE users (id int, email text);",
          "CREATE TABLE posts (id int, user_id int);",
          "-- ALTER TABLE posts ADD CONSTRAINT x FOREIGN KEY (user_id) REFERENCES users(id);",
          "/* DROP TABLE users; */",
          "INSERT INTO audit (msg) VALUES ('ALTER TABLE posts DROP COLUMN user_id; DROP TABLE posts;');",
          "ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);",
          "ALTER TABLE users ADD PRIMARY KEY (id);",
          "ALTER TABLE users ADD CHECK (id > 0);",
          "ALTER TABLE users DROP CONSTRAINT users_email_key;",
          "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey, DROP PRIMARY KEY;",
          "ALTER TABLE users ALTER COLUMN email SET DEFAULT 'x', ALTER COLUMN email DROP NOT NULL;",
          "ALTER TABLE users RENAME CONSTRAINT a TO b;",
          "ALTER TABLE ghosts ADD CONSTRAINT g FOREIGN KEY (user_id) REFERENCES users(id);",
          "DROP TABLE IF EXISTS ghosts;",
          "CREATE TEMP TABLE posts_tmp (id int);",
        ),
      });
      expect(show(facts)).toEqual(["users schema.sql:1 id:int email:text", "posts schema.sql:2 id:int user_id:int"]);
    });

    it("keeps unrelated SQL entities and ORM entities of the same name apart", () => {
      const facts = factsOf({
        "requirements.txt": "sqlalchemy\n",
        "migrations/001.sql": "CREATE TABLE Order (id int);",
        "migrations/002.sql": "DROP TABLE Order;",
        "models.py": lines(
          "from sqlalchemy.orm import DeclarativeBase",
          "class Base(DeclarativeBase): pass",
          "class Order(Base):",
          '    __tablename__ = "orders"',
        ),
      });
      expect(facts.entities.map((e) => `${e.name} ${e.orm}`)).toEqual(["Order sqlalchemy"]);
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
