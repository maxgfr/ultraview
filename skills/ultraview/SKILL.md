---
name: ultraview
description: See your app instead of reading its code. Builds an interactive, cited map of a repository for the business and for developers (capabilities, systems, data, flows, saved questions and every change the agent makes), on top of the ultraindex index. The engine extracts the facts (routes, data models, jobs, externals, imports, diffs, insights); you write only the meaning (systems, capabilities, flows, answers), every sentence cited and checked. Use only when the user explicitly asks for ultraview or for a visual map of their codebase, e.g. "map my app with ultraview", "show me how this app fits together", "save this answer as a view", "what did you change, on the map", "explain the app to the business", "fais-moi une carte de l'app".
license: MIT
metadata:
  version: 1.13.5
---

# ultraview — see your app instead of reading its code

People no longer read the code; they need a shared, cited overview of it. You
build that overview with the engine, keep it fresh, and put every change you
make on it.

Three layers, one engine copy:

| layer | says | owned by |
|---|---|---|
| codeindex | where things are: files, symbols, imports, call graph, git history | the vendored engine |
| ultraindex | what modules mean, with citations that `check` proves | the vendored engine (its library) |
| ultraview | what the app does, drawn: capabilities, systems, data, flows, questions, changes | you (meaning) + the CLI (everything else) |

**The CLI owns every fact.** Routes, calls, screens, entities, jobs,
externals, infra, the graph and its roll-ups, diffs, risk, insights and the
layout come from code, deterministically. **You own only meaning**: the
names, the systems, the capabilities, the flows, the answers to questions.
Everything you write lives in `.ultraview/` and is committed; everything the
CLI generates there is gitignored.

Node 18 or newer, no install, no key. `<skill-dir>` is the directory holding
this file; every `ultraview …` below stands for
`node <skill-dir>/scripts/ultraview.mjs … --repo <repo>` (default: the current
directory). Every command takes `--json`; prefer it when you branch on the
result.

## Invariants

- **I0 Read summaries, not data.** Never read `facts.json`, `view.json` or
  `.ultraindex/graph.json` whole. `build` prints a summary; `show`,
  `dossier` and `lens new` give one node or one question at a time.
- **I1 Every sentence cites.** Each sentence you write (summaries, notes,
  answers, timeline summaries) carries `[path:line]` or `[path:start-end]`
  from source you read, the opening summary, lead-ins, transitions,
  conclusions and list items included; a bold label (`**In short:**`) goes
  with the sentence after it; a sentence with nothing to cite is dropped
  (the exact rule: [writing.md](references/writing.md)). `check` fails a
  dead citation and an uncited sentence; fix both, never work around them.
- **I2 Never hand-copy a detected edge.** `model.json` `edges` hold only what
  the engine cannot see (queues, events, webhooks, cron, cross-repo), each
  with a `cite`. A detected import, call or data use is derived; copying it
  adds nothing and goes stale.
- **I3 History is append-only.** Never delete or rewrite a lens, a flow, a
  conversation turn, a timeline line or a recorded change set. Re-ask a stale lens under its own
  id; a mistaken timeline entry gets a correcting entry.
- **I4 Nothing outside `.ultraview/`.** The one exception is `hook install`,
  run only when the user asks: it writes `.claude/settings.local.json`
  (`--shared`: the committed `.claude/settings.json`). Never commit
  `.ultraview/index.html`, `facts.json` or `view.json`.
- **I5 Plain words.** Labels say what a thing is for ("Main server",
  "Placing an order"), not its stack ("Shop API (Express)"). Say what the code
  does today, not what its names promise.
- **I6 Audience is a choice.** `app.audience` is `everyone` unless the user
  asks for a developer map; write for the person who will open the page.
- **I7 Run `check` before you answer.** Report only what passed it.

## Route by situation

Run `ultraview status` first; it names one situation and a worklist.

| `status` says | Do |
|---|---|
| `no-index` | `build`, then the first-map loop below |
| `index-stale` | `build` (incremental; your files survive), then status again |
| `no-model` | the first-map loop from step 3 |
| `model-incomplete` | fix what the worklist names (`check` lists every error), `check` until clean |
| `stale-views` | re-ask only the stale lenses and conversation turns (a turn in its thread: `lens new --thread`) and re-check only the stale flows (`lens save` / `flow save`), then `check`; stale module prose is ultraindex's: re-read that code before citing it |
| `ready` | follow the user's intent |

Then by what the user wants:

| The user says | Do | Read |
|---|---|---|
| "map my app", "show me how it fits together" | the first-map loop | [capabilities](references/capabilities.md), [schema](references/schema.md) |
| a question about the app ("how do refunds work?") | Questions, below | [lenses](references/lenses.md) |
| a follow-up on the last answer ("and who calls it?") | Follow-ups, below | [lenses](references/lenses.md) |
| "what did you change?", "summarise this PR" | Changes, below | [change-review](references/change-review.md) |
| "explain it to the business", "a brief for the README" | `app.audience: everyone`, then `export --md` (or `--mermaid` / `--svg`) | [writing](references/writing.md) |
| "keep it open while we work" | `serve --open` | [viewer](references/viewer.md) |
| "what should we worry about?" | `insights`, then cite and explain the top ones | [engine-evidence](references/engine-evidence.md) |
| "walk me through what happens when…" | a flow | [flows](references/flows.md) |

## The first-map loop

1. `ultraview build`. Read the summary it prints: entrypoints, workspaces, top
   modules by PageRank, fact counts with examples, externals, coverage.
2. Read only the README, the manifests (`package.json`, `pyproject.toml`,
   compose files) and the entrypoints the summary names. You are after the
   shape of the app, not a code review.
3. Write `.ultraview/model.json` **systems first**: 3–9 systems whose `paths`
   globs hold at least 90% of code files. `ultraview show sys:_unassigned`
   lists what no glob holds. Cite each summary.
4. Then **capabilities**: what the app does for someone, in its users' words.
   For each candidate, `ultraview dossier <node-id>` (a route, an entity, a
   module) and write it from that evidence with cited `members`. Together they
   must claim at least 70% of non-test code modules; `ultraview show
   cap:_foundations` lists the unclaimed.
5. `ultraview check` until clean.
6. Write 1–3 flows for the app's main jobs (`flow save`) and a `tour` of 3–8
   stops. `check` again.
7. `ultraview render --open` (it draws what you saved, no rebuild needed), or
   `ultraview serve --open` for live updates.
8. Report in plain words: what the app is, its systems and capabilities in
   3–5 lines, anything surprising, the top 3 `insights` with their citations,
   and where the map is (`.ultraview/index.html`, or the served URL). Say that
   `.ultraview/model.json`, `flows/` and `lenses/` are meant to be committed.

## Questions → lenses

A question answered once is saved as a lens: a view anyone can reopen at
`#lens=<id>`, marked stale when the code it cites changes.

1. `ultraview lens new "<question>"` prints the proposed id and file, ranked
   candidate nodes, their strongest edges, source excerpts and a JSON template.
   Whenever the question is not in English, you MUST add `--terms "<English
   code keywords>"`: the words the code would use for it (`order cancel
   delete`), and the repo's own names when you know them (`checkout`,
   `OrderItem`). Keep the question as the user asked it; the terms carry the
   search. Without them the pack says `reading   not English and no --terms`:
   run it again with them.
2. Open more source if the excerpts do not settle it (`show` / `dossier` on a
   candidate; `explain <node-id>` gives a node's proven facts in cited
   sentences). Answer only what the code shows.
3. Write the lens JSON to the printed path: `answer` (every sentence cited),
   `nodes`, optional `edges`, `focus`. Leave `sources` out.
4. `ultraview lens save <file>` (stamps the hashes of the cited files), then
   `ultraview check`.
5. Answer the user in the chat too, and point at `#lens=<id>` (live when
   `serve` runs; after `render` otherwise).

Asking the same question again keeps its id and replaces the answer (a
re-ask). A different question under a taken id needs another `--id`.

## Follow-ups → a conversation

When the user follows up on an answer in the terminal ("and who calls it?",
"et ça se défait comment ?"), keep the thread instead of starting a fresh
lens, so "it" and "that" resolve to what you just talked about:

1. Once per thread: `ultraview chat new --title "<the first question>" --json`
   (its `id` is the thread). Answer the first question as a turn too.
2. Each turn: `ultraview lens new "<question>" --thread <id>` (plus
   `--terms` when it is not in English, naming what its pronouns refer to).
   The pack opens with the conversation so far and ranks the earlier turns'
   nodes and their neighbours first.
3. Fill the turn template: a cited `answer` in the question's language,
   `nodes`, `focus`, `lang`, `mode` (`business`: plain words, no code names
   unless asked; `dev`: symbols, calls, files) and exactly 3 `followUps` in
   the question's language. Write it to the printed draft path.
4. `ultraview lens save <draft> --thread <id>` (same gates as a lens, plus the
   turn's own), then `ultraview check`.
5. Answer in the chat, and point at `#chat=<id>`: when `serve` runs, the
   browser shows the new turn live. `chat promote <id> <turn>` keeps one turn
   as a standalone lens.

## Changes → diff, timeline, PR

After you change code for the user, put the change on the map:

```bash
ultraview diff --worktree --record --source agent --title "<2–5 words>" \
  --request "<what the user asked>" --summary "<cited sentences> [path:line]"
```

It maps the delta onto every level (capabilities to symbols), adds the blast
radius, per-module risk and broken imports, writes `changes/<id>.json` and
appends one timeline entry; an unchanged worktree records nothing. Point at
`#view=changes`. For a branch: `diff --base <ref>`; for a PR body: `diff
--markdown`. A note without a code change: `timeline add --title … --summary
… --ref <node-id> [--change new|changed|removed] [--note …]`. To record every
turn automatically, offer `hook install` (Claude Code only, opt-in, personal
settings file); install it only on a yes.

## Orchestration — route by harness

The judgment work fans out: one capability or one system is an independent
`dossier` → write → `check` unit. Fan out when the build summary shows more than
~40 modules, or more than ~20 candidate capabilities.

| Your harness | How |
|---|---|
| Any host with subagents (Claude Code, Codex, OpenCode…) | You write the systems and the capability list (ids, labels) first and run `check`. Then dispatch one subagent per capability (or per system, for summaries) with the contract in [orchestrate](references/orchestrate.md): its node ids, `dossier` commands, the writing rules; it RETURNS the capability JSON, it never writes `model.json`. You merge the returns and run one `check`. |
| Single agent, or no subagents | The same units in order, yourself. Identical files; only wall-clock differs. |

The one hard rule: only you write `model.json`, and no `build` runs while
subagents work (it rewrites the index and the view they are reading).

## Writing for humans

Short sentences, one claim each, cited. Business words first, the code's names
only when the audience is developers. Say what is missing or a placeholder
plainly. Never invent a number, a user, or a reason the code does not show.
Details: [writing](references/writing.md).

## Command cheat-sheet

- `status` — the situation and the worklist.
- `build [--no-ast]` — refresh the index and facts, re-assemble the view, print the summary.
- `check [--strict]` — the gate: schema, ids, citations, coverage; `--strict` fails stale lenses / flows too.
- `show <node-id>` — one node's card: kind, parent, capabilities, summary, cites, metrics, edges.
- `explain <node-id> [--mode business|dev] [--lang <xx>]` — an instant, cited answer about one node from proven facts only (no agent); `escalate: true` means the facts are thin.
- `dossier <node-id> [--budget <n>]` — the evidence to write about one node.
- `lens new "<question>" [--terms "<English keywords>"] [--id <slug>] [--budget <n>]` — the evidence pack for a question; `--terms` whenever it is not in English.
- `lens save <file> [--force]` / `flow save <file> [--force]` — validate, stamp `sources`, store.
- `lens list` — saved questions, with their stale flag.
- `chat new [--title <t>]` / `chat list` / `chat show <id>` — conversations; `lens new "<q>" --thread <id> [--context '<json>']` and `lens save <draft> --thread <id>` add a turn.
- `chat promote <id> <turn> [--lens-id <slug>] [--force]` — one turn as a lens.
- `render [--out <file>] [--open]` — the offline page, `.ultraview/index.html`, from the current agent files; notes a stale index.
- `serve [--port <n>] [--host <addr>] [--ask auto|claude|codex|none] [--ask-model <m>] [--open]` — the live map on 127.0.0.1:4178; `--ask-model` picks the model the Ask bridge runs (asks and conversation turns).
- `diff [--base <ref> | --staged | --worktree] [--depth <n>] [--record] [--markdown] [--quiet]` — the change on the map.
- `diff --record [--source agent|pr|manual] [--title <t>] [--summary <s>] [--request <r>]` — and its timeline entry.
- `timeline add --title <t> --summary <s> [--request <r>] [--source <s>] [--ref <id> [--change <c>] [--note <n>]]… | [--items <json>]`.
- `hook install|uninstall [--agent claude] [--shared] [--dry-run]` — opt-in Stop hook (`diff --worktree --record --hook`).
- `insights` — hotspots, hidden coupling, cycles, dead code, untested hubs, repeated literals.
- `export --mermaid|--svg|--md [--level cap|sys|mod] [--lens <id>] [--flow <id>] [--out <file>]`.

`ultraview --help` is the full surface. Exit codes: 0 ok, 1 a failed gate or a
refused write, 2 usage error or unknown node id.

## Will not

- Read or paste `facts.json`, `view.json` or `graph.json` whole.
- Write a sentence without a citation, or cite a line it did not read.
- Copy a detected edge into `model.json`, or invent one without a `cite`.
- Delete or rewrite a lens, a flow, a timeline line or a change set.
- Write outside `.ultraview/`, except `hook install` when the user asked.
- Commit `index.html`, `facts.json`, `view.json` or the logs.
- Serve the map beyond loopback unless the user asked for `--host`.
- Claim the map is complete: the extractors cover JS/TS and Python web stacks
  first; say what they do not see ([engine-evidence](references/engine-evidence.md)).

## References

- [schema](references/schema.md): model.json, flows, lenses, timeline: exact shapes and node ids
- [capabilities](references/capabilities.md): choosing systems and capabilities, coverage, foundations, actors
- [lenses](references/lenses.md): evidence pack → answer, stale and re-ask, conversations, the Ask bridge
- [flows](references/flows.md): writing a flow and a tour
- [change-review](references/change-review.md): diff, timeline, the hook, PR markdown
- [writing](references/writing.md): plain language, citation style, audience
- [orchestrate](references/orchestrate.md): fan-out contracts for big repos
- [viewer](references/viewer.md): what users see, deep links, serve, keyboard
- [engine-evidence](references/engine-evidence.md): what is deterministic, from which engine, and its limits
