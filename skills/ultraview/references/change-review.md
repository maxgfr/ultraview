# Changes: diff, timeline, hook, PR

## After a task

```bash
ultraview diff --worktree --record --source agent \
  --title "Refuse unknown products" \
  --request "orders with an unknown product should fail" \
  --summary "placeOrder now checks every product exists before writing. [src/services/orders.ts:14-15]"
```

- Modes: `--worktree` (staged + unstaged + untracked vs HEAD: what an agent
  leaves), `--staged`, or `--base <ref>` (the branch against its merge-base;
  default origin/HEAD, origin/main, main…). `--depth <n>`: blast radius
  (default 2 hops).
- Every level is classified `added` / `changed` / `removed` / `impacted`:
  capabilities, systems, modules, files, exported symbols, routes, screens,
  entities, jobs. Routes and entities compare their definitions and the lines
  they own, so a hunk inside a handler marks that route, not its neighbours.
- `--record` writes `changes/<id>.json` and appends one timeline entry whose
  items are the changed nodes. Nothing is recorded when the diff is empty or
  equal to the last record. Without `--summary` the entry is `auto` (counts
  only); write a cited summary when you know why the change was made.
- Show it: `#view=changes` (or `#change=<id>`).

## A note without a change

```bash
ultraview timeline add --title "Checkout reviewed" \
  --summary "Card payments go through one function. [src/pay.ts:12]" \
  --ref cap:checkout --note "No change needed. [src/pay.ts:12]"
```

`--ref` repeats (each followed by its own `--change` / `--note`), or pass
`--items '<json array>'`. Refused, not written, when an id does not resolve
or a sentence is uncited.

## For a PR

`ultraview diff --base origin/main --markdown` prints a PR body: headline
counts, what it touches in plain words, the risk table, broken imports, and a
Mermaid map of the impacted modules. Paste it; record the PR with `--record
--source pr` if the team keeps the timeline.

## The hook (opt-in)

`ultraview hook install` adds one Claude Code `Stop` hook to
`.claude/settings.local.json` (personal, never committed; `--shared` writes
`.claude/settings.json` and warns that the command holds this machine's path).
After every turn it runs `diff --worktree --record --quiet --source agent
--hook`: silent, always exits 0, skips turns that changed nothing new, logs
errors to `.ultraview/hook.log`. `--dry-run` shows the edit; `hook uninstall`
removes exactly what install added. Only on the user's request.

## Reading risk

`risk` per module comes from the engine (exported API touched, hub
centrality, blast size, test gap, coupling, dangling imports). Report the
high ones with their reasons, and every `broken` import: it is a bug until
shown otherwise.
