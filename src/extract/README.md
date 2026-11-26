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

| id              | facts      | notes                                                                                                                                                   |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `express`       | routes     | `app/router.<verb>(path, …)`, `.route(path).<verb>()` chains, same-file `use(prefix, router)` mounts; cross-file mounts via the `express-mounts` linker |
| `prisma-schema` | entities   | `model` blocks of `*.prisma` (multi-file schemas included); relations settled by the `prisma-relations` linker                                          |
| `prisma-client` | entityUses | `prisma\|db\|tx\|client.<model>.<op>(` with a known operation → read / write                                                                            |

Linkers: `express-mounts`, `prisma-relations`, `entity-uses` (a use must name
a declared entity).

## Planned (spec §5, JS/TS + Python first)

- **routes**: Next.js (app router + pages API), Nuxt server routes, SvelteKit,
  Remix, Fastify, Hono, NestJS, FastAPI, Flask, Django `urls.py`.
- **calls**: `fetch`, axios, ky, `$fetch`, requests, httpx; URL normalisation
  (template params → `:p`, base-URL prefixes stripped, query dropped) and a
  linker matching calls to routes by method + path pattern.
- **screens**: Next.js app/pages, Nuxt pages, SvelteKit routes, React Router /
  Vue Router literal route tables.
- **entities**: Drizzle, TypeORM, Mongoose, Sequelize, SQLAlchemy, Django
  models, SQL `CREATE TABLE` in migrations.
- **entityUses**: Drizzle `db.insert(orders)`, ORM model method calls on known
  entity names, SQL `INSERT/UPDATE/DELETE/SELECT … <table>` literals.
- **jobs**: BullMQ queues/workers, Celery tasks, `vercel.json` crons, GitHub
  Actions `schedule`, node-cron.
- **externals**: curated SDK map (stripe, @supabase/_, firebase_, openai,
  @anthropic-ai/sdk, @aws-sdk/*, twilio, sendgrid, resend, algolia, sentry,
  posthog…), hosts in URL literals, `process.env.X_*` prefixes.
- **infra**: docker-compose services, Dockerfiles, k8s Deployments/Services.
