# Extractors

Pure functions that turn one indexed file into facts (docs/design.md §5): no
file system, no network, no model. Each one implements `Extractor` from
`types.ts`, gates itself on the file's shape and on the dependencies its
workspace declares (`ctx.depsFor(rel)`), searches comment-masked text
(`mask.ts`), and cites every fact with `file` + `line`. Cross-file resolution
(mount prefixes, relation targets, call→route matching) belongs to a `Linker`.
Test files are skipped unless an extractor sets `includeTests`.

Every extractor has fixture tests with true positives AND explicit
false-positive guards (comments, strings, test files, docs).

## Implemented

| id                        | facts                | notes                                                                                                                                                                                                                                                                                            |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `express`                 | routes               | `app/router.<verb>(path, …)`, `.route(path).<verb>()` chains, same-file `use(prefix, router)` mounts; cross-file mounts via the `express-mounts` linker                                                                                                                                          |
| `prisma-schema`           | entities             | `model` blocks of `*.prisma` (multi-file schemas included); relations settled by the `prisma-relations` linker                                                                                                                                                                                   |
| `prisma-client`           | entityUses           | `prisma\|db\|tx\|client.<model>.<op>(` with a known operation → read / write                                                                                                                                                                                                                     |
| `fastapi`                 | routes               | `@app/router.<verb>(path)`, `api_route(methods=[…])` on `FastAPI()` / `APIRouter(prefix=…)`; `include_router(…, prefix=…)` same-file and via `python-mounts`                                                                                                                                     |
| `flask`                   | routes               | `@app/bp.route(path, methods=[…])` (one route per method), `@bp.<verb>`, `add_url_rule`; `Blueprint(url_prefix=…)`, `register_blueprint(…, url_prefix=…)`                                                                                                                                        |
| `django-urls`             | routes               | `path` / `re_path` / `url` (method `ALL`, handler = view), `include("app.urls")` / `include([...])` prefixes; DRF `router.register` list + detail routes                                                                                                                                         |
| `drf-viewsets`            | (hints)              | each DRF viewset's actions (ModelViewSet, ReadOnlyModelViewSet, mixins, `list`/`create`/… methods) for the `drf-viewsets` linker                                                                                                                                                                 |
| `python-http`             | calls                | `requests.<verb>/request`, `Session()`, `httpx.<verb>`, `Client/AsyncClient(base_url=…)`; f-string params → `:p`, config-based bases dropped, query dropped                                                                                                                                      |
| `sqlalchemy-models`       | entities             | declarative classes (`__tablename__` or a declarative base), `Column` / `mapped_column` / `Mapped[…]`, `relationship`, `ForeignKey("t.id")`                                                                                                                                                      |
| `sqlalchemy-orm`          | entityUses           | `session.query/get(X)`, `select(X)` read; `session.add(X(…))`, `insert/update/delete(X)` write; Flask-SQLAlchemy `X.query.…` read                                                                                                                                                                |
| `django-models`           | entities             | `class X(models.Model)` (or a same-file model), `models.*Field`, `ForeignKey` / `OneToOneField` / `ManyToManyField` (class, `"app.X"`, `"self"`)                                                                                                                                                 |
| `django-orm`              | entityUses           | `X.objects.<op>(…)` read / write; a write anywhere on the chain wins                                                                                                                                                                                                                             |
| `sql-schema`              | entities             | `CREATE TABLE [IF NOT EXISTS] name (…)` in `*.sql`: columns, inline and table-level `REFERENCES`; temporary tables skipped                                                                                                                                                                       |
| `sql-literals`            | (hints)              | `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` / `SELECT … FROM` / `JOIN` in string literals of any code language, for the `sql-uses` linker                                                                                                                                                     |
| `bullmq`                  | jobs                 | `new Queue("name")` → queue, `new Worker("name", …)` → worker                                                                                                                                                                                                                                    |
| `node-cron`               | jobs                 | `cron.schedule("<expr>", handler)` → `cron:<handler>` (inline callbacks: `cron:<file>`, `#2`…)                                                                                                                                                                                                   |
| `celery`                  | jobs                 | `@app.task` / `@shared_task` → worker = function name; `beat_schedule` entries → `cron:<entry>` with literal `crontab()` / seconds / `timedelta()`                                                                                                                                               |
| `vercel-crons`            | jobs                 | `vercel.json` `crons[{ path, schedule }]` → `cron:<path>`                                                                                                                                                                                                                                        |
| `github-actions-schedule` | jobs                 | `.github/workflows/*.yml` `on.schedule[].cron` → `cron:<workflow file>`                                                                                                                                                                                                                          |
| `externals`               | externals, links     | SDK imports of declared packages (`sdk-map.ts`); hosts of URL literals that reach the network (call sites, client bases, config defaults, service-named values, CSP sources, known SDK API hosts → SDK id), else `links`; env vars with a known SDK prefix                                       |
| `docker-compose`          | infra                | `services:` keys of `docker-compose*.yml` / `compose*.yaml`                                                                                                                                                                                                                                      |
| `dockerfile`              | infra                | `Dockerfile`, `Dockerfile.<variant>` → directory name (`root` at the root); `<name>.Dockerfile` → `<name>`                                                                                                                                                                                       |
| `k8s`                     | infra                | `Deployment` / `StatefulSet` / `DaemonSet` / `Service` / `CronJob` manifests → `metadata.name`                                                                                                                                                                                                   |
| `trpc`                    | (hints), calls       | `router({…})` / `t.router` / `createTRPCRouter` procedures (`.query` / `.mutation` / `.subscription`), inline and composed sub-routers, `mergeRouters`; client calls `x.a.b.useQuery` / `.useMutation` / `.query` / `.mutate` / `.queryOptions`, terminal-less server callers (settled by `rpc`) |
| `next-actions`            | routes, calls        | `"use server"` modules → every export is an `ACTION` (`<path>#<export>`); inline `"use server"` functions; imported actions called, passed to `action={}` / `formAction={}` or `useActionState`, settled by `rpc`; server-only callers skipped                                                   |
| `next-app`                | routes, screens      | `app/**/route.ts` exported `GET`/`POST`/… (every export form); `app/**/page.tsx`; also `src/app`; `(group)` / `@slot` dropped, `_private` and `(.)intercepting` skipped                                                                                                                          |
| `next-pages`              | routes, screens      | `pages/api/**` with methods from `req.method` checks (else `ALL`); other `pages/**` (not `_app`, `_document`, `_error`)                                                                                                                                                                          |
| `nuxt-server`             | routes               | `server/api/**` → `/api/…`, `server/routes/**`; method from a `.get.ts` suffix, else `ALL` (nuxt or nitro declared)                                                                                                                                                                              |
| `nuxt-pages`              | screens              | `pages/**.vue` (and Nuxt 4 `app/pages`)                                                                                                                                                                                                                                                          |
| `sveltekit`               | routes, screens      | `src/routes/**/+server.ts` exported handlers (`fallback` = `ALL`); `+page.svelte`; groups dropped, `[id=matcher]` → `:id`                                                                                                                                                                        |
| `remix`                   | routes, screens      | `app/routes/*` flat routes (Remix v2, `@react-router/fs-routes`): `loader` → GET, `action` → POST, default export → screen                                                                                                                                                                       |
| `hono`                    | routes               | `new Hono()` receivers: verbs, `on()`, chains, `basePath()`, `route(prefix, sub)` (cross-file via `js-mounts`)                                                                                                                                                                                   |
| `fastify`                 | routes               | verbs, `route({ method, url })`, `register(plugin, { prefix })` — inline / same-file plugins here, imported ones via `js-mounts`                                                                                                                                                                 |
| `nestjs`                  | routes               | `@Controller(prefix)` × `@Get(path)`/`@Post`/…, handler = method name; file must import `@nestjs/common`                                                                                                                                                                                         |
| `http-calls`              | calls                | `fetch`, axios (verbs, config, instances with `baseURL`), ky (`prefixUrl`), `ofetch` / `$fetch`, Nuxt `useFetch`; URL normalisation; `.vue` / `.svelte` scripts                                                                                                                                  |
| `react-router`            | screens              | `createBrowserRouter`/`useRoutes` literal tables, `RouteObject[]`, JSX `<Route>` trees; nested paths joined, `<Navigate>` redirects skipped                                                                                                                                                      |
| `vue-router`              | screens              | `createRouter({ routes })` literal tables and `RouteRecordRaw[]`; children joined, redirects skipped                                                                                                                                                                                             |
| `drizzle`                 | entities, entityUses | `pgTable`/`mysqlTable`/`sqliteTable` consts (fields = column builders, `.references()`, `relations()`); `db.select().from(t)` / joins / `db.query.t` → read, `insert`/`update`/`delete` → write                                                                                                  |
| `typeorm`                 | entities, entityUses | `@Entity` classes, column and relation decorators; repositories (`getRepository`, `@InjectRepository`, `Repository<T>`), `manager.op(Entity)`, Active Record statics                                                                                                                             |
| `mongoose`                | entities, entityUses | `model("Name", schema)` with same-file or inline schemas, `ref` relations; model statics on reachable names                                                                                                                                                                                      |
| `sequelize`               | entities, entityUses | `define()`, `class extends Model` + `init()`, sequelize-typescript `@Table`; associations (cross-file); statics and `models.X` registries                                                                                                                                                        |

Linkers: `express-mounts`, `js-mounts` (Hono / Fastify cross-file prefixes),
`python-mounts` (FastAPI / Flask / Django cross-file prefixes) — all three on
the shared `mounts.ts`; `orm-fields` (fields declared away from their entity,
JS ORM relations settled), `prisma-relations`, `drf-viewsets`,
`orm-relations` (SQLAlchemy / Django / SQL relations and foreign-key tables),
`sql-uses` (a SQL literal must name a declared table), `http-calls` (client
calls through imported instances; every call, JS or Python, matched to a route
by method + path pattern, most specific route wins, a call's `:p` never
matches a literal segment; runs after every linker that moves routes),
`entity-uses` (a use must name a declared entity), `rpc` (tRPC routers
composed by key across files into `route:QUERY user.byId`; tRPC and
server-action calls matched by exact method + path; before `http-calls`),
`external-hosts` (hosts of absolute-URL call facts become externals),
`infra-overlays` (one infra fact per id + kind, with `overlays`).

YAML (compose, workflows, k8s) is read by `yaml.ts`, a dependency-free,
line-based outline reader; Python lexing helpers live in `py.ts`, JS ones in
`js.ts` and `source.ts`. Call URLs from every language are normalized by one
set of rules in `urls.ts`.

Known gaps (JS/TS web): NestJS `setGlobalPrefix` and URI versioning; Fastify
autoload; React Router v7 `app/routes.ts` config routing; SvelteKit form
actions; Next `basePath`; calls through Angular `HttpClient`, SWR / React Query
keys, or clients passed around as values; Drizzle tables built with a custom
`pgTableCreator`. RPC: tRPC v9 string paths, routers or actions
re-exported through barrels, procedures built by helper functions, actions
passed around as props; aliases resolve `@/`, `~/`, `#`, `$lib` against the
workspace root, `src/` and `app/` (tsconfig `paths` are not read).

## Planned

Every extractor family of the v1 coverage list (docs/design.md §5) is
implemented; the known gaps above are what remains.
