# Schema: what you write under `.ultraview/`

Exact types: `src/model/types.ts`; the spec: `docs/design.md` §2–§6. `check`
validates every file; an unknown key is an error, not ignored.

## Node ids

| prefix | example | from |
|---|---|---|
| `cap:` | `cap:checkout`, `cap:_foundations` (derived: files no capability claims) | your capabilities |
| `sys:` | `sys:api`, `sys:_unassigned` (derived: files no glob holds) | your systems (else workspaces, else `sys:app`) |
| `mod:` | `mod:src-payments`; a slice `mod:src@database` | ultraindex module slug; `@<sys>` = the part of a module that sits in another system |
| `file:` | `file:src/pay/stripe.ts` | the index |
| `sym:` | `sym:src/pay/stripe.ts#createCharge` | the index (exported symbols) |
| `route:` | `route:POST /api/checkout`, `route:QUERY user.byId`, `route:MUTATION user.update`, `route:ACTION app/actions#save` | facts: HTTP routes; tRPC procedures; Next server actions |
| `screen:` | `screen:/cart` | facts |
| `entity:` | `entity:Order` | facts (ORM models, SQL tables) |
| `job:` | `job:send-receipts` (a queue or worker), `job:cron:<handler>` | facts |
| `ext:` | `ext:stripe` | facts (SDK import, host, env prefix) |
| `infra:` | `infra:db` | facts (compose, Dockerfile, k8s) |

Never guess an id: take it from the build summary, `lens new`, `show` or
`dossier`. `show <id>` answers 2 with suggestions when it does not exist.
A capability member `mod:<slug>` claims every slice of the module;
`mod:<slug>@<sys>` claims that slice only.

## model.json

```json
{
  "schema": 1,
  "app": { "name": "Shop", "summary": "A small online store where customers browse products and place orders. [README.md:3]", "audience": "everyone" },
  "systems": [
    { "id": "api", "label": "Main server", "kind": "service",
      "summary": "The web server that answers the shop's requests, with the order routes under /api. [src/server.ts:7]",
      "paths": ["src/**"], "exclude": [] },
    { "id": "database", "label": "Database", "kind": "data",
      "summary": "The shop's data model and the client the server reaches it with. [prisma/schema.prisma:36] [src/db.ts:3]",
      "paths": ["prisma/**", "src/db.ts"] }
  ],
  "capabilities": [
    { "id": "ordering", "label": "Placing an order",
      "summary": "A customer orders a list of products, and an order naming an unknown product is refused. [src/services/orders.ts:12-15]",
      "actors": ["customer"],
      "members": ["route:POST /api/orders", "sym:src/services/orders.ts#placeOrder", "entity:Order"],
      "paths": [], "tags": [] }
  ],
  "edges": [
    { "from": "sys:database", "to": "sys:api", "kind": "config", "label": "connection string from DATABASE_URL", "cite": "prisma/schema.prisma:10" }
  ],
  "tour": [ { "node": "cap:ordering", "note": "Start here: placing an order is what the shop is for. [src/services/orders.ts:12]" } ],
  "glossary": [ { "term": "Order item", "meaning": "One product line of an order, with its quantity. [prisma/schema.prisma:47-54]" } ]
}
```

- `systems[].kind`: `ui service worker library data external infra script test config`.
- `systems[].paths` / `exclude`: globs over repo paths. A file goes to the
  most specific matching glob (longest literal prefix, then declaration
  order); `src/db.ts` above beats `src/**`.
- `capabilities[].members`: node ids; `paths`: globs whose files are members
  too. One file may serve several capabilities.
- `edges[].kind`: `import call http data event queue extends config contains`;
  `cite` is required (`path:line`).
- `app.audience`: `everyone` (default) or `developers`.
- Ids are slugs (`a-z0-9-`), unique per list.

## flows/<id>.json

```json
{ "schema": 1, "id": "place-order", "title": "What happens when someone places an order",
  "trigger": "route:POST /api/orders",
  "steps": [
    { "node": "route:POST /api/orders", "note": "A POST to /api/orders answers 201 with the new order. [src/routes/orders.ts:10-12]" },
    { "node": "entity:Order", "note": "The order and its items are written in one create call. [src/services/orders.ts:16-21]" } ] }
```

## lenses/<id>.json

```json
{ "schema": 1, "id": "how-cancel-works", "question": "How does cancelling an order work?",
  "answer": "DELETE /api/orders/:id hands the id from the URL to cancelOrder. [src/routes/orders.ts:19-21]\n\nThe order is not deleted: its status is set back to PENDING. [src/services/orders.ts:26]",
  "nodes": ["route:DELETE /api/orders/:id", "sym:src/services/orders.ts#cancelOrder", "entity:Order"],
  "edges": [ { "from": "route:DELETE /api/orders/:id", "to": "entity:Order", "kind": "data" } ],
  "focus": "route:DELETE /api/orders/:id" }
```

`sources` (path → sha256 of each cited file) is stamped by `lens save` /
`flow save`; never write it. A cited file whose hash changes makes the lens
or flow **stale**.

## timeline.jsonl

One stable-JSON object per line, appended by `diff --record` or `timeline add`,
never edited:

```json
{"at":"2026-02-03T04:05:06.000Z","items":[{"change":"changed","ref":"cap:ordering","note":"Refuses an unknown product. [src/services/orders.ts:15]"}],"request":"Refuse orders for unknown products","source":"agent","summary":"placeOrder now checks every product exists before writing. [src/services/orders.ts:14-15]","title":"Refuse unknown products"}
```

`source`: `agent`, `pr` or `manual`. `summary` must cite, unless the entry
is `auto` (written by `diff --record` without `--summary`). `items[].ref`
must resolve, except `removed` ones. `changes/<id>.json` (the change sets)
are generated: see `docs/design.md` §6.
