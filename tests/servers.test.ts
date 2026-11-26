import { describe, expect, it } from "vitest";
import { factsOfFiles } from "./helpers.js";

const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

function routesOf(files: Record<string, string>): string[] {
  return factsOfFiles(files).routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line} ${r.framework}${r.handler ? ` ${r.handler}` : ""}`);
}

describe("hono", () => {
  const hono = { "package.json": pkg({ hono: "^4" }) };

  it("verb routes, on(), chains, basePath, same-file route() mounts", () => {
    expect(
      routesOf({
        ...hono,
        "src/index.ts": [
          'import { Hono } from "hono";',
          'const app = new Hono<{ Bindings: Env }>().basePath("/api");',
          "const users = new Hono();",
          'users.get("/", listUsers).post("/", createUser);',
          'users.get("/:id{[0-9]+}", getUser);',
          'app.on(["PUT", "PATCH"], "/items/:id", (c) => c.text("ok"));',
          'app.route("/users", users);',
          'const v2 = app.basePath("/v2");',
          'v2.delete("/items/:id", removeItem);',
          "const rpc = new Hono()",
          "  .use(logger())",
          '  .get("/ping", (c) => c.text("pong"));',
          "export default app;",
        ].join("\n"),
      }),
    ).toEqual([
      "GET /api/users src/index.ts:4 hono listUsers",
      "POST /api/users src/index.ts:4 hono createUser",
      "GET /api/users/:id src/index.ts:5 hono getUser",
      "PATCH /api/items/:id src/index.ts:6 hono",
      "PUT /api/items/:id src/index.ts:6 hono",
      "DELETE /api/v2/items/:id src/index.ts:9 hono removeItem",
      "GET /ping src/index.ts:12 hono",
    ]);
  });

  it("cross-file route() mounts through the js-mounts linker, aliases included", () => {
    expect(
      routesOf({
        ...hono,
        "src/app.ts":
          'import { Hono } from "hono";\nimport books from "./books";\nimport { authors } from "@/authors";\nconst app = new Hono();\napp.route("/books", books);\napp.route("/authors", authors);\n',
        "src/books.ts": 'import { Hono } from "hono";\nconst books = new Hono();\nbooks.get("/", list);\nexport default books;\n',
        "src/authors/index.ts": 'import { Hono } from "hono";\nexport const authors = new Hono().get("/:id", show);\n',
      }),
    ).toEqual(["GET /authors/:id src/authors/index.ts:2 hono show", "GET /books src/books.ts:3 hono list"]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, strings, non-Hono receivers, tests and markdown", () => {
      expect(
        routesOf({
          ...hono,
          "src/index.ts": [
            'import { Hono } from "hono";',
            "const app = new Hono();",
            '// app.get("/commented", h);',
            "console.log(\"app.get('/in-log', h)\");",
            "const cache = new Map();",
            'cache.get("/not-a-route");',
            'app.get("/real", h);',
          ].join("\n"),
          "src/index.test.ts": 'import { Hono } from "hono";\nconst app = new Hono();\napp.get("/test-only", h);\n',
          "README.md": 'app.get("/docs-only", h)',
        }),
      ).toEqual(["GET /real src/index.ts:7 hono h"]);
    });

    it("needs hono declared", () => {
      expect(routesOf({ "package.json": pkg({}), "src/index.ts": 'import { Hono } from "hono";\nconst app = new Hono();\napp.get("/x", h);\n' })).toEqual([]);
    });
  });
});

describe("fastify", () => {
  const fastify = { "package.json": pkg({ fastify: "^5", "fastify-plugin": "^5" }) };

  it("verbs, route({ method, url }), inline and same-file plugins with prefixes", () => {
    expect(
      routesOf({
        ...fastify,
        "src/server.ts": [
          'import Fastify from "fastify";',
          "const app = Fastify({ logger: true });",
          'app.get("/health", async () => "ok");',
          'app.route({ method: ["GET", "HEAD"], url: "/items", handler: listItems });',
          "async function admin(instance, opts) {",
          '  instance.delete("/cache", clearCache);',
          "}",
          'app.register(admin, { prefix: "/admin" });',
          "app.register(async (api) => {",
          '  api.post("/orders", { schema }, createOrder);',
          '  api.register(async (v1) => { v1.get("/me", me); }, { prefix: "/v1" });',
          '}, { prefix: "/api" });',
        ].join("\n"),
      }),
    ).toEqual([
      "GET /health src/server.ts:3 fastify",
      "GET /items src/server.ts:4 fastify listItems",
      "HEAD /items src/server.ts:4 fastify listItems",
      "DELETE /admin/cache src/server.ts:6 fastify clearCache",
      "POST /api/orders src/server.ts:10 fastify createOrder",
      "GET /api/v1/me src/server.ts:11 fastify me",
    ]);
  });

  it("imported plugins get their prefix through the linker; the plugin convention `fastify` is a receiver", () => {
    expect(
      routesOf({
        ...fastify,
        "src/app.js": 'const app = require("fastify")();\napp.register(require("./routes/users"), { prefix: "/users" });\n',
        "src/routes/users.js": 'module.exports = async function (fastify) {\n  fastify.get("/:id", getUser);\n};\n',
        "src/main.ts":
          'import Fastify from "fastify";\nimport fp from "fastify-plugin";\nimport books from "./books";\nconst server = Fastify();\nserver.register(fp(books), { prefix: "/books" });\n',
        "src/books.ts":
          'import type { FastifyInstance } from "fastify";\nexport default async function books(app: FastifyInstance) {\n  app.get("/", list);\n}\n',
      }),
    ).toEqual(["GET /books src/books.ts:3 fastify list", "GET /users/:id src/routes/users.js:2 fastify getUser"]);
  });

  describe("false-positive guards", () => {
    it("ignores other receivers, settings getters, comments and strings", () => {
      expect(
        routesOf({
          ...fastify,
          "src/server.ts": [
            'import Fastify from "fastify";',
            "const app = Fastify();",
            'const store = new Map([["/x", 1]]);',
            'store.get("/x");',
            'app.get("/only-one-arg");',
            '// app.post("/commented", h);',
            "const s = \"app.get('/in-string', h)\";",
          ].join("\n"),
        }),
      ).toEqual([]);
    });

    it("needs fastify declared", () => {
      expect(
        routesOf({ "package.json": pkg({ express: "^4" }), "src/plugin.ts": 'export default async function (fastify) { fastify.get("/x", h); }\n' }),
      ).toEqual([]);
    });
  });
});

describe("nestjs", () => {
  const nest = { "package.json": pkg({ "@nestjs/common": "^10", "@nestjs/core": "^10" }) };

  it("controller prefixes (string, array, { path }) and method decorators", () => {
    expect(
      routesOf({
        ...nest,
        "src/cats.controller.ts": [
          'import { All, Controller, Get, Post, Put, UseGuards } from "@nestjs/common";',
          '@Controller(["cats", "kittens"])',
          "export class CatsController {",
          "  @Get()",
          "  findAll() {}",
          "",
          '  @Put(":id")',
          "  @UseGuards(AuthGuard)",
          '  async update(@Param("id") id: string, @Body() dto: UpdateCatDto) {}',
          "",
          '  @Post(["a", "b"])',
          "  static make() {}",
          "}",
          "",
          '@Controller({ path: "/health/", version: "1" })',
          "export class HealthController {",
          '  @All("*")',
          "  any() {}",
          "}",
          "",
          "@Controller()",
          "export class RootController {",
          "  @Get()",
          "  root() {}",
          "}",
        ].join("\n"),
      }),
    ).toEqual([
      "GET /cats src/cats.controller.ts:4 nestjs findAll",
      "GET /kittens src/cats.controller.ts:4 nestjs findAll",
      "PUT /cats/:id src/cats.controller.ts:7 nestjs update",
      "PUT /kittens/:id src/cats.controller.ts:7 nestjs update",
      "POST /cats/a src/cats.controller.ts:11 nestjs make",
      "POST /cats/b src/cats.controller.ts:11 nestjs make",
      "POST /kittens/a src/cats.controller.ts:11 nestjs make",
      "POST /kittens/b src/cats.controller.ts:11 nestjs make",
      "ALL /health/* src/cats.controller.ts:17 nestjs any",
      "GET / src/cats.controller.ts:23 nestjs root",
    ]);
  });

  describe("false-positive guards", () => {
    it("needs the file to import @nestjs/common (routing-controllers has its own @Get)", () => {
      expect(
        routesOf({
          ...nest,
          "src/legacy.ts": 'import { JsonController, Get } from "routing-controllers";\n@Controller("legacy")\nexport class L {\n  @Get("/x")\n  x() {}\n}\n',
        }),
      ).toEqual([]);
    });

    it("ignores commented decorators, undecorated classes, non-literal paths, and specs", () => {
      expect(
        routesOf({
          ...nest,
          "src/a.controller.ts": [
            'import { Controller, Get } from "@nestjs/common";',
            "// @Controller('ghost')",
            "export class NotAController {",
            '  @Get("x")',
            "  x() {}",
            "}",
            "@Controller(PREFIX)",
            "export class Dynamic {",
            "  @Get()",
            "  y() {}",
            "}",
          ].join("\n"),
          "src/a.controller.spec.ts": 'import { Controller, Get } from "@nestjs/common";\n@Controller("spec")\nexport class S {\n  @Get()\n  z() {}\n}\n',
        }),
      ).toEqual([]);
    });

    it("needs @nestjs declared", () => {
      expect(
        routesOf({
          "package.json": pkg({}),
          "src/c.ts": 'import { Controller, Get } from "@nestjs/common";\n@Controller("c")\nexport class C {\n  @Get()\n  a() {}\n}\n',
        }),
      ).toEqual([]);
    });
  });
});
