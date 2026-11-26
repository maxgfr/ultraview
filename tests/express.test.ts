import { describe, expect, it } from "vitest";
import { expressExtractor, expressMountLinker, joinRoutePath } from "../src/extract/express.js";
import { emptyFacts, runExtractors } from "../src/extract/index.js";
import type { RouteFact } from "../src/extract/types.js";
import { memoryContext } from "./helpers.js";

const PKG = { "package.json": '{"dependencies":{"express":"^4"}}' };

function routesOf(files: Record<string, string>): string[] {
  const all: Record<string, string> = { ...PKG, ...files };
  const facts = runExtractors("/repo", Object.keys(all), (abs) => all[abs.slice("/repo/".length)]);
  return facts.routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line}${r.handler ? ` ${r.handler}` : ""}`);
}

describe("express extractor", () => {
  it("extracts verb routes on express() and Router() receivers, with handlers", () => {
    const routes = routesOf({
      "src/app.ts": [
        'import express from "express";',
        "const app = express();",
        "const api = express.Router();",
        'app.get("/", home);',
        "app.post('/login', auth.login);",
        'api.put("/items/:id", validate, items.update);',
        'api.patch("/items/:id", (req, res) => res.end());',
        'api.delete("/items/:id", items.remove);',
        'app.all("*", notFound);',
      ].join("\n"),
    });
    expect(routes).toEqual([
      "GET / src/app.ts:4 home",
      "POST /login src/app.ts:5 auth.login",
      "PUT /items/:id src/app.ts:6 items.update",
      "PATCH /items/:id src/app.ts:7",
      "DELETE /items/:id src/app.ts:8 items.remove",
      "ALL * src/app.ts:9 notFound",
    ]);
  });

  it("walks .route() chains, one route per chained verb, each on its own line", () => {
    const routes = routesOf({
      "src/r.js": ['const { Router } = require("express");', "const router = Router();", 'router.route("/books")', "  .get(list)", "  .post(create);"].join(
        "\n",
      ),
    });
    expect(routes).toEqual(["GET /books src/r.js:4 list", "POST /books src/r.js:5 create"]);
  });

  it("applies same-file mounts, nested", () => {
    const routes = routesOf({
      "src/app.ts": [
        'import express, { Router } from "express";',
        "const app = express();",
        "const v1 = Router();",
        "const users = Router();",
        'users.get("/", listUsers);',
        'users.get("/:id", getUser);',
        'v1.use("/users", users);',
        'app.use("/api/v1", v1);',
      ].join("\n"),
    });
    expect(routes).toEqual(["GET /api/v1/users src/app.ts:5 listUsers", "GET /api/v1/users/:id src/app.ts:6 getUser"]);
  });

  it("applies cross-file mounts through the linker (import and require)", () => {
    const routes = routesOf({
      "src/server.ts": [
        'import express from "express";',
        'import { ordersRouter as orders } from "./routes/orders.js";',
        'const admin = require("./routes/admin");',
        "const app = express();",
        'app.use("/api", auth, orders);',
        'app.use("/admin", admin);',
        'app.use("/legacy", require("./routes/legacy"));',
      ].join("\n"),
      "src/routes/orders.ts": 'import { Router } from "express";\nexport const ordersRouter = Router();\nordersRouter.get("/orders", list);\n',
      "src/routes/admin/index.js": 'const router = require("express").Router();\nrouter.post("/reindex", reindex);\nmodule.exports = router;\n',
      "src/routes/legacy.js": 'const express = require("express");\nconst r = express.Router();\nr.get("/", old);\nmodule.exports = r;\n',
    });
    expect(routes).toEqual([
      "POST /admin/reindex src/routes/admin/index.js:2 reindex",
      "GET /legacy src/routes/legacy.js:3 old",
      "GET /api/orders src/routes/orders.ts:3 list",
    ]);
  });

  it("accepts parameters typed Express / Router", () => {
    const routes = routesOf({
      "src/register.ts": 'import type { Express } from "express";\nexport function register(server: Express) {\n  server.get("/typed", h);\n}\n',
    });
    expect(routes).toEqual(["GET /typed src/register.ts:3 h"]);
  });

  describe("false-positive guards", () => {
    it("ignores commented-out routes, routes inside strings, and the settings getter", () => {
      const routes = routesOf({
        "src/app.ts": [
          'import express from "express";',
          "const app = express();",
          '// app.get("/commented", h);',
          '/* app.post("/blocked", h); */',
          "console.log(\"app.get('/in-string', h)\");",
          "const msg = `try app.get('/in-template', h)`;",
          'if (app.get("env") === "production") app.set("trust proxy", 1);',
          'app.get("/real", h);',
        ].join("\n"),
      });
      expect(routes).toEqual(["GET /real src/app.ts:8 h"]);
    });

    it("needs express declared by the nearest workspace", () => {
      const files = { "package.json": '{"dependencies":{"fastify":"^4"}}', "src/app.ts": 'const app = express();\napp.get("/x", h);\n' };
      const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length) as keyof typeof files]);
      expect(facts.routes).toEqual([]);
    });

    it("does not read markdown, tests, or receivers that are not Express", () => {
      const routes = routesOf({
        "docs/api.md": "app.get('/fake', h)",
        "src/app.test.ts": 'import express from "express";\nconst app = express();\napp.get("/only-in-test", h);\n',
        "src/client.ts": 'import axios from "axios";\nconst app = axios.create();\nawait app.get("/api/orders", cfg);\n',
        "src/types.d.ts": 'declare const app: Express;\napp.get("/declared", h);\n',
      });
      expect(routes).toEqual([]);
    });

    it("skips non-literal and non-path first arguments", () => {
      const routes = routesOf({
        "src/app.ts": 'import express from "express";\nconst app = express();\napp.get(`/v${n}/x`, h);\napp.get(PATH, h);\napp.get("relative", h);\n',
      });
      expect(routes).toEqual([]);
    });
  });

  it("gates on JS-like files and the express dependency", () => {
    const ctx = memoryContext({ ...PKG, "a.ts": "", "a.md": "", "a.d.ts": "" });
    expect(expressExtractor.applies({ rel: "a.ts", text: "" }, ctx)).toBe(true);
    expect(expressExtractor.applies({ rel: "a.md", text: "" }, ctx)).toBe(false);
    expect(expressExtractor.applies({ rel: "a.d.ts", text: "" }, ctx)).toBe(false);
  });

  it("joins mount prefixes like Express", () => {
    expect(joinRoutePath("/api", "/")).toBe("/api");
    expect(joinRoutePath("/api/", "/x")).toBe("/api/x");
    expect(joinRoutePath("", "/x")).toBe("/x");
    expect(joinRoutePath("/", "/")).toBe("/");
  });

  it("linker leaves facts alone without resolvable mounts, and cuts cycles", () => {
    const route: RouteFact = { method: "GET", path: "/x", file: "a.ts", line: 1, framework: "express" };
    const base = { ...emptyFacts(), routes: [route] };
    const ctx = { ...memoryContext({ "a.ts": "", "b.ts": "" }) };
    expect(expressMountLinker.link(base, { ...ctx, hints: [] })).toBe(base);
    const cyclic = expressMountLinker.link(base, {
      ...ctx,
      hints: [
        { kind: "mount", framework: "express", file: "b.ts", line: 1, prefix: "/b", target: "a" },
        { kind: "mount", framework: "express", file: "a.ts", line: 1, prefix: "/a", target: "b" },
      ],
    });
    expect(cyclic.routes.map((r) => r.path)).toEqual(["/a/b/x"]);
  });
});
