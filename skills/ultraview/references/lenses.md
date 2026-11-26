# Lenses: one question, one saved view

## From evidence pack to answer

`ultraview lens new "<question>"` (read-only, deterministic) prints:

- `id` and `file`: the slug of the question, made unique; the same question
  asked again keeps its id (`re-ask`). `--id <slug>` picks one.
- **Candidates**, named nodes first: routes, screens, entities, jobs,
  symbols and capabilities ranked by the question's rare words, in their names
  first and their definitions, fields or summaries second, with a bonus when
  the wording points at their kind ("fields", "stored" → entities), method
  ("fetch" → GET, "cancel" → DELETE) or shape ("by its id" → `/:id`). Then the
  modules ultraindex `find` ranks. A French question is read through a small
  lexicon of everyday app words (`commande` → `order`).
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
commands; Codex in its read-only sandbox), with this same `lens new` pack, and saves the reply
with `lens save`. One ask at a time, 180 s timeout; nothing is written but the
lens; the agent's output goes to `.ultraview/ask.log`. An ask never replaces
another question's lens.
