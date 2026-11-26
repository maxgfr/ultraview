import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { Facts } from "../src/extract/types.js";
import { captureIo, copyFixture } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/** Build a temp copy of a fixture twice; the facts must be byte-identical, and match the committed snapshot. */
async function buildTwice(name: string): Promise<{ facts: Facts; raw: string; summary: string }> {
  const { dir, cleanup } = copyFixture(name);
  cleanups.push(cleanup);
  const cap = captureIo();
  expect(await main(["build", "--repo", dir, "--no-ast"], cap.io)).toBe(0);
  const raw = readFileSync(join(dir, ".ultraview", "facts.json"), "utf8");
  expect(await main(["build", "--repo", dir, "--no-ast"], captureIo().io)).toBe(0);
  expect(readFileSync(join(dir, ".ultraview", "facts.json"), "utf8")).toBe(raw);
  await expect(raw).toMatchFileSnapshot(`./__snapshots__/${name}.facts.json`);
  return { facts: JSON.parse(raw) as Facts, raw, summary: cap.out() };
}

const routes = (f: Facts) => f.routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line} ${r.framework}${r.handler ? ` ${r.handler}` : ""}`);
const calls = (f: Facts) => f.calls.map((c) => `${c.method} ${c.url} ${c.file}:${c.line} -> ${c.route ?? "-"}`);
const screens = (f: Facts) => f.screens.map((s) => `${s.path} ${s.file}:${s.line} ${s.framework}`);
const entities = (f: Facts) =>
  f.entities.map((e) => `${e.name} ${e.orm} ${e.file}:${e.line} ${e.fields.map((x) => `${x.name}:${x.type}${x.relation ? `->${x.relation}` : ""}`).join(",")}`);
const uses = (f: Facts) => f.entityUses.map((u) => `${u.entity} ${u.op} ${u.file}:${u.line}`);

describe("next-drizzle fixture", () => {
  it("routes, calls matched to them, screens, Drizzle entities and uses — and nothing from comments, logs, tests or docs", async () => {
    const { facts, summary } = await buildTwice("next-drizzle");
    expect(routes(facts)).toEqual([
      "GET /api/auth/*nextauth src/app/api/auth/[...nextauth]/route.ts:3 next-app handler",
      "POST /api/auth/*nextauth src/app/api/auth/[...nextauth]/route.ts:3 next-app handler",
      "POST /api/orders src/app/api/orders/route.ts:4 next-app POST",
      "GET /api/products/:id src/app/api/products/[id]/route.ts:6 next-app GET",
      "PATCH /api/products/:id src/app/api/products/[id]/route.ts:11 next-app PATCH",
      "DELETE /api/products/:id src/app/api/products/[id]/route.ts:18 next-app DELETE",
      "GET /api/products src/app/api/products/route.ts:4 next-app GET",
      "POST /api/products src/app/api/products/route.ts:8 next-app POST",
      "POST /api/webhook src/pages/api/webhook.ts:3 next-pages handler",
    ]);
    expect(calls(facts)).toEqual([
      "POST /api/orders src/components/AddToCart.tsx:9 -> route:POST /api/orders",
      "GET /api/products/:p src/components/AddToCart.tsx:13 -> route:GET /api/products/:id",
      "GET /api/products src/components/CartView.tsx:8 -> route:GET /api/products",
      "PATCH /api/products/:p src/components/CartView.tsx:13 -> route:PATCH /api/products/:id",
      "DELETE /api/products/:p src/components/CartView.tsx:16 -> route:DELETE /api/products/:id",
      "POST https://api.stripe.com/v1/refunds src/components/CartView.tsx:17 -> -",
    ]);
    expect(screens(facts)).toEqual([
      "/cart src/app/(shop)/cart/page.tsx:3 next-app",
      "/ src/app/(shop)/page.tsx:3 next-app",
      "/products/:id src/app/(shop)/products/[id]/page.tsx:4 next-app",
      "/dashboard src/app/dashboard/@stats/page.tsx:1 next-app",
      "/dashboard src/app/dashboard/page.tsx:1 next-app",
      "/docs/*slug src/app/docs/[[...slug]]/page.tsx:1 next-app",
    ]);
    expect(entities(facts)).toEqual([
      "users drizzle src/db/schema.ts:3 id:serial,email:text,name:text,orders:orders[]->orders",
      "products drizzle src/db/schema.ts:9 id:serial,name:text,priceCents:integer",
      "orders drizzle src/db/schema.ts:15 id:serial,userId:integer->users,productId:integer->products,createdAt:timestamp,user:users->users,product:products->products",
    ]);
    expect(uses(facts)).toEqual([
      "products read src/db/queries.ts:6",
      "products read src/db/queries.ts:10",
      "products write src/db/queries.ts:15",
      "products write src/db/queries.ts:19",
      "orders write src/db/queries.ts:23",
      "users read src/db/queries.ts:27",
    ]);
    expect(summary).toMatch(/^ {2}calls +6$/m);
  });
});

describe("nuxt-mongoose fixture", () => {
  it("server routes from file names, $fetch / useFetch calls in .vue scripts, pages, Mongoose models and statics", async () => {
    const { facts } = await buildTwice("nuxt-mongoose");
    expect(routes(facts)).toEqual([
      "ALL /api/orders server/api/orders.ts:3 nuxt",
      "DELETE /api/products/:id server/api/products/[id].delete.ts:3 nuxt",
      "GET /api/products/:id server/api/products/[id].get.ts:3 nuxt",
      "GET /api/products server/api/products/index.get.ts:3 nuxt",
      "POST /api/products server/api/products/index.post.ts:3 nuxt",
      "ALL /health server/routes/health.ts:1 nuxt",
    ]);
    expect(calls(facts)).toEqual([
      "GET /api/orders composables/useOrders.ts:2 -> route:ALL /api/orders",
      "POST /api/orders composables/useOrders.ts:6 -> route:ALL /api/orders",
      "GET /api/products pages/index.vue:2 -> route:GET /api/products",
      "GET /api/products/:p pages/products/[id].vue:3 -> route:GET /api/products/:id",
      "DELETE /api/products/:p pages/products/[id].vue:6 -> route:DELETE /api/products/:id",
      "GET /api/products pages/products/index.vue:2 -> route:GET /api/products",
      "POST /api/products pages/products/index.vue:5 -> route:POST /api/products",
    ]);
    expect(screens(facts)).toEqual(["/ pages/index.vue:1 nuxt", "/products/:id pages/products/[id].vue:1 nuxt", "/products pages/products/index.vue:1 nuxt"]);
    // `ref: "Customer"` names no declared model: the field stays, the relation does not.
    expect(entities(facts)).toEqual([
      "Order mongoose server/models/order.ts:3 product:ObjectId->Product,lines:ObjectId[]->Product,customer:ObjectId,status:String",
      "Product mongoose server/models/product.ts:3 name:String,priceCents:Number,tags:String[],dimensions:Object",
    ]);
    expect(uses(facts)).toEqual([
      "Order write server/api/orders.ts:4",
      "Order read server/api/orders.ts:5",
      "Product write server/api/products/[id].delete.ts:5",
      "Product read server/api/products/[id].get.ts:4",
      "Product read server/api/products/index.get.ts:4",
      "Product write server/api/products/index.post.ts:5",
    ]);
  });
});

describe("nest-typeorm fixture", () => {
  it("controller routes with prefixes, TypeORM entities with relations, repository reads and writes", async () => {
    const { facts } = await buildTwice("nest-typeorm");
    expect(routes(facts)).toEqual([
      "GET /api/orders src/orders/orders.controller.ts:8 nestjs list",
      "POST /api/orders/checkout src/orders/orders.controller.ts:13 nestjs checkout",
      "GET /users src/users/users.controller.ts:8 nestjs findAll",
      "GET /users/:id src/users/users.controller.ts:13 nestjs findOne",
      "POST /users src/users/users.controller.ts:18 nestjs create",
      "DELETE /users/:id src/users/users.controller.ts:27 nestjs remove",
    ]);
    expect(entities(facts)).toEqual([
      "Order typeorm src/orders/order.entity.ts:4 id:string,totalCents:number,user:User->User",
      "User typeorm src/users/user.entity.ts:4 id:number,email:string,name:string,orders:Order[]->Order,createdAt:Date",
    ]);
    // `usersRepository.create()` builds an instance in memory: not a write.
    expect(uses(facts)).toEqual([
      "Order read src/orders/orders.service.ts:12",
      "Order write src/orders/orders.service.ts:16",
      "User read src/users/users.service.ts:14",
      "User read src/users/users.service.ts:18",
      "User write src/users/users.service.ts:23",
      "User write src/users/users.service.ts:28",
    ]);
    expect(facts.calls).toEqual([]);
    expect(facts.screens).toEqual([]);
  });
});
