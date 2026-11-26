# Evals

`pnpm run eval` (`node evals/run.mjs [--case <id>] [--verbose]`) runs every
case under `cases/` through the committed bundle, `scripts/ultraview.mjs`,
against a temp copy of a fixture repo from `tests/fixtures/` (built with
`--no-ast`, no network). It writes nothing in the repository and exits 1 when
an assertion fails. CI runs it in the `build-test` job.

## A case

`cases/<id>/case.json`:

```jsonc
{
  "description": "…",
  "kind": "lens",                       // lens | flow | model
  "fixture": "shop-express-prisma",     // tests/fixtures/<fixture>
  "model": "shop.model.json",           // optional: tests/fixtures-models/<model>, written before the build
  "heldOut": false,
  "questions": { "en": ["…"], "fr": ["…"], "es": ["…"], "…": ["…"] },   // en fr es de it pt nl ja zh ar ru
  "terms": { "en": ["…"], "fr": ["…"], "…": ["…"] },                   // per language, one --terms string per question
  "expect": { "nodes": ["route:DELETE /api/orders/:id"], "top": 10, "minRecall": 0.8, "cites": ["src/services/orders.ts"] },
  "bad": { "fails": "save", "reasons": ["dead citation [src/services/orders.ts:24-47]"], "defect": "…" }
}
```

- **Ranking**: each question goes through `lens new --json`, once as asked and
  once with `--terms "<terms.<lang>[i]>"` (the English code keywords an agent
  passes for it); it is a hit when every `expect.nodes` id is in the first
  `expect.top` candidates. Gates: without terms, the English and French hit
  rates of each case must reach `expect.minRecall`; with terms, each
  language's recall over all the cases must reach English's recall without
  terms, less 2 points. The other languages without terms are measured, not
  gated: they are what `--terms` is for.
- **Good answer** (`answer.good.json`): `lens save` / `flow save` (a model is
  written as `.ultraview/model.json`), then `check`, must pass; the answer must
  hold every `expect.nodes` id and cite every file of `expect.cites`.
- **Bad answer** (`answer.bad.json`): must stop at `bad.fails` (`save`,
  `check`, or `expect` for what the gates cannot see) with every
  `bad.reasons` string in the messages.

## Cases

| case | fixture | checks | bad answer's defect |
|---|---|---|---|
| shop-place-order | shop | ranking, good, bad | a sentence without its citation (`check`) |
| shop-cancel-order | shop | ranking, good, bad | a citation past the end of the file (`lens save`) |
| shop-order-data | shop | ranking, good, bad | an unknown node id (`check`) |
| shop-health | shop | ranking, good, bad | every citation moved to another file at the same lines: resolves, so `check` passes; `expect.cites` fails |
| shop-order-lookup | shop | ranking, good, bad | a cited file that does not exist (`lens save`) |
| shop-products | shop | ranking, good, bad | the key node left out of `nodes` (`expect`) |
| shop-model | shop | good, bad | a narrowed system glob (coverage), an uncited summary, an unknown member, an uncited edge (`check`) |
| shop-flow | shop | good, bad | an unknown step node and an uncited note (`check`) |
| next-* (6) | next-drizzle, no model | ranking only, held out | – |

## Results

`lens new` recall: the share of paraphrases whose key nodes are all in the
top 10 candidates, 12 lens cases × 5 paraphrases per language, without and
with `--terms`.

| language | shop (tuned), without | shop (tuned), with terms | next-drizzle (held out), without | next-drizzle (held out), with terms | all, without | all, with terms |
|---|---:|---:|---:|---:|---:|---:|
| en | 30/30 | 30/30 | 24/30 | 29/30 | 54/60 (90%) | 59/60 (98%) |
| fr | 29/30 | 29/30 | 26/30 | 29/30 | 55/60 (92%) | 58/60 (97%) |
| es | 3/30 | 30/30 | 10/30 | 28/30 | 13/60 (22%) | 58/60 (97%) |
| de | 7/30 | 30/30 | 9/30 | 29/30 | 16/60 (27%) | 59/60 (98%) |
| it | 6/30 | 30/30 | 11/30 | 29/30 | 17/60 (28%) | 59/60 (98%) |
| pt | 9/30 | 30/30 | 15/30 | 29/30 | 24/60 (40%) | 59/60 (98%) |
| nl | 5/30 | 30/30 | 17/30 | 27/30 | 22/60 (37%) | 57/60 (95%) |
| ja | 0/30 | 30/30 | 4/30 | 29/30 | 4/60 (7%) | 59/60 (98%) |
| zh | 1/30 | 30/30 | 7/30 | 28/30 | 8/60 (13%) | 58/60 (97%) |
| ar | 5/30 | 30/30 | 2/30 | 28/30 | 7/60 (12%) | 58/60 (97%) |
| ru | 2/30 | 30/30 | 3/30 | 28/30 | 5/60 (8%) | 58/60 (97%) |

The bridge gate holds over all the cases: with terms, every language reaches
at least 88% (English without terms, 90%, less 2 points). The French lexicon
is the only bridge without terms, so French stays near English there; every
other language without terms is what `--terms` is for. The CJK rows rank on
the terms alone for now: the pinned engine splits a CJK sentence into whole
runs, so its own words match nothing (CJK bigrams come with a later engine).

History. The ranking (`src/lens.ts`, `src/lens-terms.ts`) was developed
against the English and French shop questions: 14/30 en and 3/30 fr with the
ranking of 1.8.1 (name matches counted by terms, modules first), 29/30 and
29/30 after.
The held-out questions were generated afterwards and measured once (24/30 en,
24/30 fr); one change followed, a defect they exposed rather than a tuning:
words that name a kind of node ("route", "page", "champ") are hints, not
search terms, or "route" matched every symbol of every Next `route.ts`. No
lexicon entry was added for them. With `--terms`, one ranking change
followed the shop misses (the "place an order" questions in most languages):
a symbol whose verb-noun name starts with the verb the wording points at
(`buy` → POST → `placeOrder`) earns the method bonus routes already had; it
also brought English without terms on the shop to 30/30, and changed no
held-out result. The held-out gate is lower (`minRecall` 0.6 per case) and the
misses are listed by `--verbose`: questions about behaviour the fixture does
not have (rate limits, signatures, idempotency, session storage) and words the
code does not use ("basket" for cart).

## Provenance

No eval data was produced by a proprietary model.

- **Questions**: generated by GLM 5.3 flash (open weights, MIT licence).
  Shop: 6 intents × (5 English + 5 French) paraphrases. Next-drizzle: 6
  intents × (5 + 5), generated from a plain description of each behaviour,
  without code identifiers. The es, de, it, pt, nl, ja, zh, ar and ru
  paraphrases of the 12 lens cases (5 each), added later: generated by GLM 5.3
  flash too, copied into `case.json` verbatim (not edited).
- **Terms** (`case.json` `terms`, one `--terms` string per question in all 11
  languages): generated by GLM 5.3 flash with the questions above, as an
  agent would write them (English code keywords), copied verbatim.
- **Good lens answers** (`shop-*/answer.good.json`): written by GLM 5.3 flash
  from the fixture's line-numbered source and the list of node ids, then
  checked by `lens save` + `check` and read against the cited lines. Not
  edited.
- **Good model and flow** (`shop-model`, `shop-flow`): the repository's test
  files, `tests/fixtures-models/shop.model.json` and `shop.flow.json`.
- **Bad answers**: each is its good answer with the defect of its case
  introduced by a small hand edit (a path, a line number, an id, a dropped
  citation or member), spelled out in `case.json` `bad.defect`.
