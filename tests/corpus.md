# Extractor corpus run

Real repositories the extractors are checked against by hand (issue #6). Each
run builds a scratch copy of the tracked files (`git ls-files`), never the
original checkout, with `ultraview build --no-ast` and
`CODEINDEX_NO_GRAMMARS_PULL=1`. Repository names only: no code from them is
copied here or into fixtures; regressions found on them are reproduced with
small synthetic snippets in the unit tests.

Run: 2026-11-26, facts schema 2.

## Counts

`before` is the 1.3.0 release, `after` this change. Time is the whole build
(index + extractors + view), wall clock, one run.

| repo                      |        | routes | calls | screens | entities | entityUses | jobs | externals | infra | links | time |
| ------------------------- | ------ | -----: | ----: | ------: | -------: | ---------: | ---: | --------: | ----: | ----: | ---: |
| egapro                    | before |     43 |     3 |      51 |       33 |        100 |    2 |       120 |    25 |     – | 2.1s |
|                           | after  |    129 |   119 |      51 |       33 |        100 |    2 |        81 |    21 |    26 | 2.3s |
| egapro-v1                 | before |     14 |     2 |      68 |       18 |         37 |    0 |       124 |    28 |     – | 1.0s |
|                           | after  |     37 |    19 |      68 |       18 |         37 |    0 |        58 |    19 |    30 | 1.1s |
| cdtn-admin                | before |     23 |    14 |      53 |       66 |          0 |    1 |        83 |    22 |     – | 1.3s |
|                           | after  |     23 |    14 |      53 |       66 |          0 |    1 |        31 |    22 |    15 | 1.4s |
| code-du-travail-numerique | before |     13 |    10 |      63 |        0 |          0 |    3 |       168 |     1 |     – | 2.2s |
|                           | after  |     13 |    10 |      63 |        0 |          0 |    3 |        69 |     1 |    43 | 2.3s |
| nautilus-trading          | before |      0 |     0 |       0 |        0 |          0 |    0 |        17 |     3 |     – | 0.4s |
|                           | after  |      0 |     0 |       0 |        0 |          0 |    0 |        13 |     3 |     1 | 0.4s |
| infra                     | before |      0 |     0 |       0 |        0 |          0 |    0 |         0 |     1 |     – | 0.1s |
|                           | after  |      0 |     0 |       0 |        0 |          0 |    0 |         0 |     1 |     0 | 0.1s |

Host externals (`via: host`) before → after: egapro 42 facts / 11 ids → 4 / 4;
egapro-v1 70 / 8 → 4 / 2; cdtn-admin 63 / 10 → 11 / 8;
code-du-travail-numerique 121 / 28 → 22 / 10; nautilus-trading 14 / 4 → 10 / 3.
The rest of the externals (SDK imports, SDK env prefixes) is unchanged except
GitHub Actions runner variables, no longer read as the GitHub API.

## Precision sample

About 10 random facts per kind and repo (all of them when fewer), each read
in context and marked correct when it is what the kind claims. `–` = no facts.

| repo                      | routes | calls | screens | entities | entityUses | jobs | externals | infra | links |
| ------------------------- | -----: | ----: | ------: | -------: | ---------: | ---: | --------: | ----: | ----: |
| egapro                    |  10/10 | 10/10 |   10/10 |    10/10 |      10/10 |  2/2 |      9/10 | 10/10 | 10/10 |
| egapro-v1                 |  10/10 | 10/10 |   10/10 |    10/10 |      10/10 |    – |     10/10 | 10/10 | 10/10 |
| cdtn-admin                |  10/10 | 10/10 |   10/10 |    10/10 |          – |  1/1 |     10/10 | 10/10 | 10/10 |
| code-du-travail-numerique |  10/10 | 10/10 |   10/10 |        – |          – |  3/3 |     10/10 |   1/1 | 10/10 |
| nautilus-trading          |      – |     – |       – |        – |          – |    – |     10/10 |   3/3 |   0/1 |
| infra                     |      – |     – |       – |        – |          – |    – |         – |   1/1 |     – |

A link is correct when it is not a service the code talks to.

## Notes

- **tRPC** (egapro): 86 procedures, the same count as the procedure keys of
  its routers, composed under the 17 keys of the root router across files;
  116 RPC calls (React hooks and server-side `api.x.y()` callers), all matched
  to their procedure. Before, the app's UI → server flow showed 3 calls.
- **Server actions** (egapro-v1): 23 actions = the 23 exports of its 11
  `"use server"` modules; 17 calls from client components, all matched. 7
  invocations from server-only modules (pages, async components) are skipped
  on purpose: they run the function in-process, not over the network.
- **Externals vs links**: the UI hyperlinks the issue listed (regulator and
  public-service sites, the sitemap namespace, a tool's download page, a
  `exemple.*` placeholder) are no longer externals; hyperlinks are `links`.
  `gouv.fr` is now a public suffix, so `travail-emploi.gouv.fr` and
  `api.gouv.fr` are distinct hosts instead of one `gouv.fr`.
- **Infra overlays**: the k8s units repeated across `.kontinuous/env/*`
  (egapro) and the compose services repeated across compose overrides
  (egapro-v1) are one fact each, with `overlays`.

### Fixed while sampling (each with a synthetic regression test)

- `*_URL` constants in UI components (repository, dataset, feedback links)
  were externals: `*_URL` alone now counts only in a settings module;
  `*_HOST` / `*_ENDPOINT` / `*_API*` / `*_DSN` count anywhere.
- `baseUrl` used to build page links, and `_BASE_URL` (leading underscore
  read as camelCase): `base` / `prefix` alone are weak qualifiers outside a
  settings module; leading underscores are ignored.
- URLs assigned to a variable passed to an HTTP call of the same file
  (`url = …` then `get(url)` / `urlopen(URL)`), including Python
  parenthesized multi-line literals, were links: now externals.
- `git().clone("https://…")` (a method on a call result) was not seen as a
  call site.
- CSP `connect-src` / `script-src` / `frame-src` sources were links: they are
  third parties the page talks to or embeds; `img-src` / `font-src` stay links.
- `GITHUB_REF_NAME` / `GITHUB_SHA` (runner variables in a release config)
  were the GitHub API.
- Server-action calls from server-only modules (see above).

### Known misses

- A configuration default that is a support portal or the app's own public
  URL (`process.env.PUBLIC_URL ?? "https://…"`) counts as an external: by
  rule a configuration default reaches the network, and the extractor cannot
  tell the app's own domain.
- A URL reaching a call through an attribute or a second variable
  (`self.ping_url = TESTNET_URL` … `Request(self.ping_url)`) stays a link.
- Test setup files outside the engine's test-path rules (`jest.setup.js`,
  `cypress/support`, `__fixtures__`) still contribute links.
