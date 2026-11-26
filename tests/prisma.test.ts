import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { baseType, prismaClientExtractor, prismaSchemaExtractor } from "../src/extract/prisma.js";
import { memoryContext } from "./helpers.js";

function factsOf(files: Record<string, string>) {
  return runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
}

const SCHEMA = [
  "// model Ghost { id Int @id }",
  "enum Role {",
  "  ADMIN",
  "}",
  "model User {",
  "  id    Int     @id",
  "  role  Role    @default(ADMIN)",
  "  posts Post[]",
  '  bio   String? @default("model Fake {")',
  '  @@map("users")',
  "}",
  "",
  "model Post {",
  "  id       Int  @id",
  "  author   User @relation(fields: [authorId], references: [id])",
  "  authorId Int",
  "  price    Decimal @db.Decimal(10, 2)",
  "}",
].join("\n");

describe("prisma schema extractor", () => {
  it("extracts models with fields, relations settled against declared models", () => {
    const facts = factsOf({ "prisma/schema.prisma": SCHEMA });
    expect(facts.entities).toEqual([
      {
        name: "User",
        orm: "prisma",
        file: "prisma/schema.prisma",
        line: 5,
        fields: [
          { name: "id", type: "Int" },
          { name: "role", type: "Role" },
          { name: "posts", type: "Post[]", relation: "Post" },
          { name: "bio", type: "String?" },
        ],
      },
      {
        name: "Post",
        orm: "prisma",
        file: "prisma/schema.prisma",
        line: 13,
        fields: [
          { name: "id", type: "Int" },
          { name: "author", type: "User", relation: "User" },
          { name: "authorId", type: "Int" },
          { name: "price", type: "Decimal" },
        ],
      },
    ]);
  });

  it("resolves relations across a multi-file schema", () => {
    const facts = factsOf({
      "prisma/schema/user.prisma": "model User {\n  id Int @id\n  posts Post[]\n}\n",
      "prisma/schema/post.prisma": "model Post {\n  id Int @id\n  author User @relation(fields: [a], references: [id])\n  a Int\n}\n",
    });
    expect(facts.entities.map((e) => [e.name, e.fields.filter((f) => f.relation).map((f) => f.relation)])).toEqual([
      ["Post", ["User"]],
      ["User", ["Post"]],
    ]);
  });

  it("only applies to .prisma files", () => {
    const ctx = memoryContext({});
    expect(prismaSchemaExtractor.applies({ rel: "prisma/schema.prisma", text: "" }, ctx)).toBe(true);
    expect(prismaSchemaExtractor.applies({ rel: "docs/schema.md", text: "" }, ctx)).toBe(false);
  });

  it("strips list/optional modifiers for the base type", () => {
    expect(baseType("OrderItem[]")).toBe("OrderItem");
    expect(baseType("User?")).toBe("User");
  });
});

describe("prisma client extractor", () => {
  const PKG = '{"dependencies":{"@prisma/client":"^6"}}';
  const SCHEMA2 = "model Order {\n  id Int @id\n}\nmodel OrderItem {\n  id Int @id\n}\n";

  it("reads and writes by operation name, mapping accessors to models", () => {
    const facts = factsOf({
      "package.json": PKG,
      "prisma/schema.prisma": SCHEMA2,
      "src/svc.ts": [
        "export async function f(tx) {",
        "  await prisma.order.findMany();",
        "  await this.prisma.orderItem.createMany({ data });",
        "  await tx.order.upsert({});",
        "  await db.order.count();",
        "  await prisma.order.delete({ where });",
        "}",
      ].join("\n"),
    });
    expect(facts.entityUses).toEqual([
      { entity: "Order", file: "src/svc.ts", line: 2, op: "read" },
      { entity: "OrderItem", file: "src/svc.ts", line: 3, op: "write" },
      { entity: "Order", file: "src/svc.ts", line: 4, op: "write" },
      { entity: "Order", file: "src/svc.ts", line: 5, op: "read" },
      { entity: "Order", file: "src/svc.ts", line: 6, op: "write" },
    ]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, strings, unknown operations, and models the schema does not declare", () => {
      const facts = factsOf({
        "package.json": PKG,
        "prisma/schema.prisma": SCHEMA2,
        "src/svc.ts": [
          "// prisma.order.deleteMany();",
          'log("prisma.order.create(x)");',
          "prisma.order.$queryRaw();",
          "prisma.order.findAll();",
          "prisma.cache.count();",
          "notprisma.order.create();",
        ].join("\n"),
      });
      expect(facts.entityUses).toEqual([]);
    });

    it("needs @prisma/client or prisma declared, and skips markdown and tests", () => {
      const ctx = memoryContext({ "package.json": '{"dependencies":{"mongoose":"^8"}}', "a.ts": "" });
      expect(prismaClientExtractor.applies({ rel: "a.ts", text: "" }, ctx)).toBe(false);
      const facts = factsOf({
        "package.json": PKG,
        "docs/a.md": "prisma.order.create()",
        "src/a.test.ts": "prisma.order.create()",
      });
      expect(facts.entityUses).toEqual([]);
    });
  });
});
