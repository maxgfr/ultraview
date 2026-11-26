---
name: ultraview
description: See your app instead of reading its code. Builds an interactive, cited map of a repository for the business and for developers (capabilities, systems, data, flows, saved questions and every change the agent makes), on top of the ultraindex index. Use only when the user explicitly asks for ultraview or for a visual map of their codebase.
license: MIT
metadata:
  version: 0.0.0
---

# ultraview (under construction)

This skill is being built. Today `node scripts/ultraview.mjs build` refreshes the
ultraindex index and extracts the repository's routes and data models into
`.ultraview/facts.json`, and `node scripts/ultraview.mjs status` says what to do
next; the map itself, the viewer and the full agent loop arrive in later
releases. Run `node scripts/ultraview.mjs --help` for the current surface.
