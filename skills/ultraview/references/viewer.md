# The viewer

One offline HTML page (`render`) or the same page served live (`serve`).
Light and dark, English and French interface, keyboard navigable, a list
fallback on phones.

## What users see

- **Map**, semantic zoom: Business (capabilities, actors, data, outside
  services) → Systems → Modules → Files → Symbols. Double-click goes inside;
  the breadcrumb climbs. Big levels group cards by folder.
- **Side panel** for the selected node: cited summary (citations open in the
  editor or the repo website), what it serves, numbers (lines, tests, churn),
  members, what it uses and what uses it, and "Ask your agent" (copies a
  prompt naming the node id).
- **Data**: the entities with their relations; selecting one highlights who
  reads and writes it.
- **Flows**: a stepper over the map. **Lenses**: saved questions with their
  answer and subgraph; stale ones greyed with "re-ask". **Changes**: the
  latest change set over the map (added, changed, impacted, risk) and the
  timeline. **Insights**: findings with a prompt to copy. **Start here**: the
  tour.
- Business / Developer audience toggle (Business hides the Files and Symbols
  levels and technical labels); Cmd/Ctrl-K search over every node.

When served, the rpc edges, the hub summaries, the Ask box and a banner for a
stale index are in the viewer as well (`docs/design.md` §8.1 has the server
side).

## Deep links

`#view=map&level=sys&node=sys:api`, `#view=data&node=entity:Order`,
`#lens=<id>`, `#flow=<id>&step=2`, `#change=<id>`; levels are `biz sys mod
file sym`, views `map data flows lenses changes insights`. Give the user a link,
not instructions to click.

## render or serve

- `render [--out <file>] [--open]`: one self-contained file. It re-assembles
  `view.json` from the current model, flows, lenses, timeline and changes (no
  re-indexing), so what you saved shows without a `build`. When source files
  changed since the last `build`, it says the index is stale (`"stale": true`
  with `--json`) and still draws the map as of that build.
- `serve [--open] [--port 4178] [--host 127.0.0.1] [--ask …] [--ask-model <m>]`: re-assembles
  on every `.ultraview/` change and pushes it to open pages (no reload); a
  source change only marks the index stale until `build`. Loopback only unless
  `--host` is passed explicitly. `/api/node`, `/api/search`,
  `/api/callgraph` and `POST /api/explain` (the `explain` answer) answer on
  demand. `--ask-model` is the model the Ask bridge runs.

## Keyboard

Cmd/Ctrl-K or `/`: search. On a focused card, arrows move to the nearest card,
Enter opens it, Space selects it, Esc clears the selection or closes the
panel. `+` / `-` zoom, `0` fits. In the tour,
← / → step, Esc ends.
