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

| id                        | facts      | notes                                                                                                                                                        |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `express`                 | routes     | `app/router.<verb>(path, …)`, `.route(path).<verb>()` chains, same-file `use(prefix, router)` mounts; cross-file mounts via the `express-mounts` linker      |
| `prisma-schema`           | entities   | `model` blocks of `*.prisma` (multi-file schemas included); relations settled by the `prisma-relations` linker                                               |
| `prisma-client`           | entityUses | `prisma\|db\|tx\|client.<model>.<op>(` with a known operation → read / write                                                                                 |
| `fastapi`                 | routes     | `@app/router.<verb>(path)`, `api_route(methods=[…])` on `FastAPI()` / `APIRouter(prefix=…)`; `include_router(…, prefix=…)` same-file and via `python-mounts` |
| `flask`                   | routes     | `@app/bp.route(path, methods=[…])` (one route per method), `@bp.<verb>`, `add_url_rule`; `Blueprint(url_prefix=…)`, `register_blueprint(…, url_prefix=…)`    |
| `django-urls`             | routes     | `path` / `re_path` / `url` (method `ALL`, handler = view), `include("app.urls")` / `include([...])` prefixes; DRF `router.register` list + detail routes     |
| `drf-viewsets`            | (hints)    | each DRF viewset's actions (ModelViewSet, ReadOnlyModelViewSet, mixins, `list`/`create`/… methods) for the `drf-viewsets` linker                             |
| `python-http`             | calls      | `requests.<verb>/request`, `Session()`, `httpx.<verb>`, `Client/AsyncClient(base_url=…)`; f-string params → `:p`, config-based bases dropped, query dropped  |
| `sqlalchemy-models`       | entities   | declarative classes (`__tablename__` or a declarative base), `Column` / `mapped_column` / `Mapped[…]`, `relationship`, `ForeignKey("t.id")`                  |
| `sqlalchemy-orm`          | entityUses | `session.query/get(X)`, `select(X)` read; `session.add(X(…))`, `insert/update/delete(X)` write; Flask-SQLAlchemy `X.query.…` read                            |
| `django-models`           | entities   | `class X(models.Model)` (or a same-file model), `models.*Field`, `ForeignKey` / `OneToOneField` / `ManyToManyField` (class, `"app.X"`, `"self"`)             |
| `django-orm`              | entityUses | `X.objects.<op>(…)` read / write; a write anywhere on the chain wins                                                                                         |
| `sql-schema`              | entities   | `CREATE TABLE [IF NOT EXISTS] name (…)` in `*.sql`: columns, inline and table-level `REFERENCES`; temporary tables skipped                                   |
| `sql-literals`            | (hints)    | `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` / `SELECT … FROM` / `JOIN` in string literals of any code language, for the `sql-uses` linker                 |
| `bullmq`                  | jobs       | `new Queue("name")` → queue, `new Worker("name", …)` → worker                                                                                                |
| `node-cron`               | jobs       | `cron.schedule("<expr>", handler)` → `cron:<handler>` (inline callbacks: `cron:<file>`, `#2`…)                                                               |
| `celery`                  | jobs       | `@app.task` / `@shared_task` → worker = function name; `beat_schedule` entries → `cron:<entry>` with literal `crontab()` / seconds / `timedelta()`           |
| `vercel-crons`            | jobs       | `vercel.json` `crons[{ path, schedule }]` → `cron:<path>`                                                                                                    |
| `github-actions-schedule` | jobs       | `.github/workflows/*.yml` `on.schedule[].cron` → `cron:<workflow file>`                                                                                      |
| `externals`               | externals  | SDK imports of declared packages (`sdk-map.ts`), absolute URL hosts → registrable domain, env vars with a known SDK prefix                                   |
| `docker-compose`          | infra      | `services:` keys of `docker-compose*.yml` / `compose*.yaml`                                                                                                  |
| `dockerfile`              | infra      | `Dockerfile`, `Dockerfile.<variant>` → directory name (`root` at the root); `<name>.Dockerfile` → `<name>`                                                   |
| `k8s`                     | infra      | `Deployment` / `StatefulSet` / `DaemonSet` / `Service` / `CronJob` manifests → `metadata.name`                                                               |

Linkers: `express-mounts`, `prisma-relations`, `python-mounts` (FastAPI /
Flask / Django cross-file prefixes, through the shared `mounts.ts`),
`drf-viewsets`, `orm-relations` (SQLAlchemy / Django / SQL relations and
foreign-key tables), `sql-uses` (a SQL literal must name a declared table),
`entity-uses` (a use must name a declared entity).

YAML (compose, workflows, k8s) is read by `yaml.ts`, a dependency-free,
line-based outline reader; Python lexing helpers live in `py.ts`.

## Planned (spec §5, JS/TS + Python first)

- **routes**: Next.js (app router + pages API), Nuxt server routes, SvelteKit,
  Remix, Fastify, Hono, NestJS.
- **calls**: `fetch`, axios, ky, `$fetch`; a linker matching calls to routes
  by method + path pattern.
- **screens**: Next.js app/pages, Nuxt pages, SvelteKit routes, React Router /
  Vue Router literal route tables.
- **entities**: Drizzle, TypeORM, Mongoose, Sequelize.
- **entityUses**: Drizzle `db.insert(orders)`, JS ORM model method calls on
  known entity names.
