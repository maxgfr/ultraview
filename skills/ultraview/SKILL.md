---
name: ultraview
description: See your app instead of reading its code. Builds an interactive, cited map of a repository for the business and for developers (capabilities, systems, data, flows, saved questions and every change the agent makes), on top of the ultraindex index. Use only when the user explicitly asks for ultraview or for a visual map of their codebase.
license: MIT
metadata:
  version: 1.6.0
---

# ultraview (under construction)

This skill is being built. Today `node scripts/ultraview.mjs build` refreshes the
ultraindex index, extracts the repository's routes and data models into
`.ultraview/facts.json` and merges everything into `.ultraview/view.json`;
`status` says what to do next; `check` gates what the agent writes into
`.ultraview/model.json`, flows and lenses (ids, citations, coverage, staleness);
`dossier <node-id>` and `show <node-id>` give the evidence and a card for one
node; `lens save` / `flow save` stamp and store a saved question or flow;
`render` writes the map as one offline page, `.ultraview/index.html` (`--open`
opens it; deep links such as `#lens=<id>` or `#view=map&node=<id>` point the
user at a view).

After a change, `diff --worktree --record --source agent --title "…" --summary
"… [path:line]"` maps what changed (and what it impacts) onto the map, writes
`.ultraview/changes/<id>.json` and appends one timeline entry; `diff
--markdown` prints a PR summary with a Mermaid diagram. `timeline add` appends
a note without a change. `hook install` (only when the user asks) records every
Claude Code turn automatically, from `.claude/settings.local.json` (`--shared`
for the committed `.claude/settings.json`). `insights` lists hotspots, hidden
coupling, cycles, dead code, untested hubs and repeated literals, each with a
prompt to hand back to the user; `export --md` / `--mermaid` / `--svg` produce
a brief or a diagram for a README or PR. The full agent loop arrives in later
releases. Run `node scripts/ultraview.mjs --help` for the current surface.
