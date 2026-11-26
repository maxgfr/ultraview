// End-to-end builds of the Python / SQL / jobs / externals / infra fixtures:
// one byte-stable facts.json snapshot each, plus the facts that matter spelled
// out, so a snapshot refresh cannot silently drop them.

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

async function build(name: string): Promise<{ raw: string; facts: Facts; out: string }> {
  const { dir, cleanup } = copyFixture(name);
  cleanups.push(cleanup);
  const cap = captureIo();
  expect(await main(["build", "--repo", dir, "--no-ast"], cap.io)).toBe(0);
  const first = readFileSync(join(dir, ".ultraview", "facts.json"), "utf8");
  expect(await main(["build", "--repo", dir, "--no-ast"], captureIo().io)).toBe(0);
  expect(readFileSync(join(dir, ".ultraview", "facts.json"), "utf8")).toBe(first);
  return { raw: first, facts: JSON.parse(first) as Facts, out: cap.out() };
}

const at = (r: { file: string; line: number }) => `${r.file}:${r.line}`;

describe("fastapi-sqlalchemy fixture", () => {
  it("builds byte-stable facts matching the snapshot", async () => {
    const { raw, facts, out } = await build("fastapi-sqlalchemy");
    await expect(raw).toMatchFileSnapshot("./__snapshots__/fastapi-sqlalchemy.facts.json");

    expect(facts.routes.map((r) => `${r.method} ${r.path} ${r.handler} ${at(r)}`)).toEqual([
      "GET / root app/main.py:14",
      "GET /health health app/routers/health.py:6",
      "GET /api/orders list_orders app/routers/orders.py:15",
      "GET /api/orders/:order_id get_order app/routers/orders.py:20",
      "POST /api/orders create_order app/routers/orders.py:25",
      "POST /api/orders/:order_id/cancel cancel_order app/routers/orders.py:34",
      "PUT /api/orders/:order_id/cancel cancel_order app/routers/orders.py:34",
      "GET /api/users/:user_id get_user app/routers/users.py:9",
    ]);
    expect(facts.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /payments", "GET /payments/:p", "POST https://api.stripe.com/v1/charges"]);
    expect(facts.entities.map((e) => `${e.name} ${e.orm}`)).toEqual([
      "User sqlalchemy",
      "Order sqlalchemy",
      "OrderItem sqlalchemy",
      "users sql",
      "orders sql",
      "audit_log sql",
    ]);
    expect(facts.entityUses.map((u) => `${u.entity} ${u.op} ${at(u)}`)).toContain("audit_log write app/db.py:23");
    expect(facts.jobs.map((j) => `${j.kind} ${j.id}`)).toEqual([
      "cron cron:.github/workflows/nightly.yml",
      "worker send_receipt",
      "worker nightly_report",
      "cron cron:nightly-report",
      "cron cron:flush-receipts",
    ]);
    expect(facts.infra.map((i) => `${i.kind} ${i.id}`)).toEqual(["dockerfile root", "compose-service api", "compose-service db", "compose-service redis"]);
    expect([...new Set(facts.externals.map((e) => e.id))].sort()).toEqual(["stripe", "stripe.com"]);
    // Tests, docs and the README never contribute.
    for (const kind of ["routes", "calls", "entities", "entityUses", "jobs", "externals", "infra"] as const) {
      for (const r of facts[kind]) expect(r.file).not.toMatch(/^(?:tests|docs)\/|README/);
    }
    expect(out).toMatch(/^ {2}routes +8$/m);
  });
});

describe("django-shop fixture", () => {
  it("builds byte-stable facts matching the snapshot", async () => {
    const { raw, facts, out } = await build("django-shop");
    await expect(raw).toMatchFileSnapshot("./__snapshots__/django-shop.facts.json");

    expect(facts.routes.map((r) => `${r.method} ${r.path} ${r.handler} ${at(r)}`)).toEqual([
      "ALL /shop views.order_list orders/urls.py:6",
      "ALL /shop/:pk views.OrderDetail orders/urls.py:7",
      "ALL /shop/checkout/start views.checkout_start orders/urls.py:12",
      "ALL /shop/checkout/done views.checkout_done orders/urls.py:13",
      "DELETE /api/orders/:pk OrderViewSet shop/urls.py:9",
      "GET /api/orders OrderViewSet shop/urls.py:9",
      "GET /api/orders/:pk OrderViewSet shop/urls.py:9",
      "PATCH /api/orders/:pk OrderViewSet shop/urls.py:9",
      "POST /api/orders OrderViewSet shop/urls.py:9",
      "PUT /api/orders/:pk OrderViewSet shop/urls.py:9",
      "GET /api/products ProductViewSet shop/urls.py:10",
      "GET /api/products/:pk ProductViewSet shop/urls.py:10",
      "ALL /admin admin.site.urls shop/urls.py:13",
      "ALL /legacy/:slug legacy_product shop/urls.py:16",
    ]);
    expect(facts.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /stock/:p", "POST https://hooks.slack.com/services/T000/B000/XXX"]);
    expect(facts.entities.map((e) => `${e.name} -> ${e.fields.flatMap((f) => (f.relation ? [f.relation] : [])).join(",")}`)).toEqual([
      "Customer -> ",
      "Product -> ",
      "Order -> Customer,Product,Order",
      "OrderItem -> Order,Product",
    ]);
    expect(facts.entityUses.map((u) => `${u.entity} ${u.op} ${at(u)}`)).toEqual([
      "Order read orders/api.py:7",
      "Product read orders/api.py:11",
      "Order read orders/views.py:16",
      "Order read orders/views.py:23",
      "Order write orders/views.py:28",
      "Product read orders/views.py:33",
      "Order write orders/views.py:35",
    ]);
    expect(facts.externals.map((e) => `${e.id} ${e.via} ${at(e)}`)).toEqual([
      "stripe sdk orders/views.py:4",
      "slack.com host orders/views.py:40",
      "stripe env shop/settings.py:4",
    ]);
    expect(facts.jobs).toEqual([]);
    expect(out).toMatch(/^ {2}routes +14$/m);
  });
});
