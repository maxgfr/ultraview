# Lenses: one question, one saved view

## From evidence pack to answer

`ultraview lens new "<question>"` (read-only, deterministic) prints:

- `id` and `file`: the slug of the question, made unique; the same question
  asked again keeps its id (`re-ask`). `--id <slug>` picks one.
- **Candidates**, named nodes first: routes, screens, entities, jobs,
  symbols and capabilities ranked by the question's rare words, in their names
  first and their definitions, fields or summaries second, with a bonus when
  the wording points at their kind ("fields", "stored" → entities), method
  ("fetch" → GET, "cancel" → DELETE: a route's, or a symbol's leading verb,
  `cancelOrder`) or shape ("by its id" → `/:id`). Then the
  modules ultraindex `find` ranks.
- `reading`, when the question is not in English: whether it was read
  through `--terms` (see below).
- The strongest edges around them, source excerpts within `--budget` tokens
  (default 6000), the JSON template and the steps.

Then:

1. Read the excerpts. When they do not settle it, `show` / `dossier` a
   candidate or open the file. The candidates are hints, not the answer.
2. Answer in 2–5 sentences, each cited (see [writing](writing.md)). Say what
   the code does, including when it surprises ("the order is not deleted").
3. `nodes`: what the answer is about (3–8 ids); `focus`: the one to centre on;
   `edges`: only the links the answer relies on.
4. `lens save <file>`, `check`, then answer the user and give `#lens=<id>`.

A lens answers one question. A second question is a second lens.

## A question in any language

Code is mostly written in English, so a question asked in another language
finds little on its own words. Whenever the question is not in English, pass
`--terms "<English code keywords>"`: 3–8 words the code would use for what is
asked (`order cancel delete`, `cart quantity update`), plus the repo's own
names when you know them (`checkout`, `OrderItem`, `sku`). Keep the question
in the user's words; it is saved as asked.

- Each term weighs as much as an English question's word, stemmed the same
  way (`cancelled` → `cancel`); the one-way synonyms apply (`buy` → `order`).
- The question's own words still count, at a quarter of a term's weight, so
  code written in that language is found too, but they never outrank a term.
- The kind, method and cardinality hints read the terms too (`delete` →
  DELETE, `fields` → entities).
- The question counts as not English (`bridged` in `--json`) when it holds a
  French marker word (`le`, `est`, `quand`…), when most of its letters are not
  Latin (Cyrillic, Arabic, CJK…), or when terms are given and under a fifth of
  its words are English stopwords.
- Without terms, a French question falls back on a small lexicon of everyday
  app words (`commande` → `order`); any other language ranks on its own words
  only, which rarely match. The pack then says so on its `reading` line.

An English question can take `--terms` too: they are added to its words.

## Stale lenses and re-asking

`lens save` stamps the sha256 of every cited file. When one changes (the whole
file, not just its exports), the lens is stale: `check` warns (`--strict`
fails), `lens list` flags it, the viewer greys it with "re-ask". Re-ask with
the same question: `lens new` keeps the id; read the new code; save. Never
delete a stale lens to silence the warning.

## The Ask bridge

`serve --ask auto|claude|codex|none` (default `auto`: claude, then codex, when
installed) adds `POST /api/ask`: the viewer's Ask box sends a question, the
server runs that agent's CLI read-only (Claude Code in its don't-ask
permission mode, allowed only Read, Glob, Grep and ultraview's read-only
commands; Codex in its read-only sandbox), with this same `lens new` pack (the
prompt asks the agent to add `--terms` when the question is not in English),
and saves the reply with `lens save`. One ask at a time, 180 s timeout;
nothing is written but the lens; the agent's output goes to `.ultraview/ask.log`. An ask never replaces
another question's lens.

`serve --ask-model <model>` picks the model the agent CLI runs (handed to
Claude Code or Codex as its model option; letters, digits and
`. _ : / @ [ ] -` only): a smaller model (`sonnet`, `haiku`) answers a
follow-up faster. Without it the agent's own default runs.

## Explain: answers without the agent

`ultraview explain <node-id> [--mode business|dev] [--lang <xx>] [--json]`
(and `POST /api/explain {"node", "mode", "lang"}` when served) answers "what
is this?" instantly from what is already proven: the node's checked prose
(its summary, tour stop, flow steps; only the sentences whose citations
resolve), its extractor facts (a route's method, path and handler, an
entity's fields and relations, a job's schedule) and its neighbourhood
(callers and callees from the engine's call sites, data read and written,
routes served, externals reached), every sentence cited where its evidence
sits. `business` never names a symbol or a file; `dev` does. The templates are
in English and French (`--lang fr`); any other language falls back to English
and says so (`langFallback`). The result has the lens answer's shape
(`answer`, `nodes`, `edges`) plus `citations` and `escalate`: true when the
node has no prose and fewer than 2 facts beyond what it is. Then the facts
are thin: ask the question as a lens instead.
