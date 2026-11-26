# Engine evidence

What the map shows comes from code, deterministically; what you write is
checked against it. Know which is which, and say what it cannot see.

## Who computes what

| fact | engine |
|---|---|
| files, modules, PageRank, import edges, symbols, line table for citations | codeindex, through ultraindex's index (`.ultraindex/`) |
| module meaning (optional), `find` ranking used by `lens new`, citation checks | ultraindex |
| routes, calls, screens, entities, entity uses, jobs, externals, links, infra | ultraview extractors (`src/extract/`): pure, one file at a time, plus linkers |
| roll-ups to modules, systems, capabilities; coverage; staleness | ultraview assembler |
| change sets: delta, blast radius, risk, broken imports | codeindex delta + ultraview's fact diff |
| insights: hotspots, hidden coupling, cycles, dead code, untested hubs, literals | codeindex analyses, thresholds in `src/insights.ts` |

Engine results locate evidence; read the cited lines before claiming
anything. Absence in the facts is not absence in the code.

## Coverage

- Routes: Express, Fastify, Hono, NestJS, Next (app and pages), Nuxt,
  SvelteKit, Remix, FastAPI, Flask, Django (+ DRF), tRPC, Next server
  actions. Calls: fetch, axios, ky, `$fetch`, requests, httpx, tRPC clients,
  server-action calls. Entities: Prisma, Drizzle, TypeORM, Mongoose,
  Sequelize, SQLAlchemy, Django, SQL `CREATE TABLE`. Jobs: BullMQ, Celery,
  node-cron, Vercel crons, GitHub Actions schedules. Infra: compose,
  Dockerfiles, k8s.
- Not seen: other languages' frameworks (Go, Java, Ruby, PHP, .NET routes),
  NestJS global prefixes, Fastify autoload, React Router v7 config routes,
  calls through Angular `HttpClient` or SWR / React Query keys, tRPC v9 string
  paths, barrel re-exports of routers. Full list: `src/extract/README.md`.
- Checked by hand on six real repositories (`tests/corpus.md`): 10/10 sampled
  facts correct for every kind and repo but externals (9/10 on one repo) and
  links (0/1 on one). An app's own public URL used as a config default counts
  as an external.
- `--no-ast` (or no grammar cache offline) falls back to regex symbols:
  routes and entities are unaffected, symbol spans are coarser.

When a missing fact matters to an answer (a route you know exists), say the
extractor does not see it, cite the code yourself, and add a model `edge` with
a `cite` only for relations the engine cannot see.
