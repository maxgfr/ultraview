# Choosing systems and capabilities

Two cuts of the same files. **Systems** answer "what runs where" (one
assignment per file). **Capabilities** answer "what the app does for
someone" (an overlay: a file may serve several).

## Systems

- 3–9 of them. One per thing that runs or is deployed on its own (web app,
  API, worker, CLI), plus `data` for schemas and migrations, `infra` for
  deploy files, `test` if the tests are a world of their own.
- Globs from the build summary's workspaces and top modules; check with
  `show sys:_unassigned`. **Threshold: ≥ 90% of code files** (`check`).
- Carve shared code into a `library` system rather than stretching a glob.
- A module whose files fall into several systems is sliced
  (`mod:src@database`): that is expected, not an error.

## Capabilities

- Name them as a user of the app would: "Placing an order", "Following
  orders", "Signing in", not "OrderService" or "CRUD".
- Find them from the facts, not the folders: routes and screens grouped by
  what they let someone do, jobs by what they keep running, entities by who
  writes them. `dossier route:POST /api/orders` shows the handler, the data
  it touches and its neighbours.
- `members`: the routes, screens, jobs, entities and symbols that carry it;
  add `mod:` ids or `paths` globs to claim whole modules.
  **Threshold: ≥ 70% of non-test code modules** (`check`).
- `actors`: who does it (`customer`, `admin`, `operator`, `scheduler`,
  `partner-api`). The Business level draws them.
- `tags`: free labels (`ops`, `billing`); `ops` for health checks and admin
  plumbing keeps them apart from what users do.
- 3–12 capabilities for a small app; more only when the app does more.

## Shared foundations

`cap:_foundations` collects what no capability claims: configuration, the
database client, utilities. Leave genuinely shared code there; do not invent a
"Utilities" capability to pass the threshold. If the threshold fails, the
missing capability is usually a real one (`show cap:_foundations` lists the
modules): admin screens, imports, notifications.

## Examples

Good:

```json
{ "id": "ordering", "label": "Placing an order", "actors": ["customer"],
  "summary": "A customer orders a list of products, and an order naming an unknown product is refused. [src/services/orders.ts:12-15]",
  "members": ["route:POST /api/orders", "sym:src/services/orders.ts#placeOrder", "entity:Order"] }
```

Bad, and why:

- `"label": "Orders API (Express)"`: the stack, not what it does.
- `"summary": "Handles orders."`: uncited, says nothing.
- `"members": ["route:POST /orders"]`: an id that does not exist (the route is
  mounted under `/api`); take ids from `lens new`, `show`, `dossier`.
- one capability per folder: that is the module level again.
