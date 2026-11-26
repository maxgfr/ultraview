# Orchestration: fanning out a big repo

Fan out when the build summary shows more than ~40 modules or more than ~20
candidate capabilities. The unit of work is one capability (or one system
summary): `dossier` → write → return.

## You (the orchestrator)

1. `build`, read the summary, write `systems` and run `check` until system
   coverage passes. Subagents never change systems.
2. Write the capability list: `id`, `label`, the seed node ids for each (from
   the summary, `lens new`, `show`). Commit nothing yet.
3. Dispatch one subagent per capability (batch small ones: 3–5 per agent).
4. Merge the returned JSON into `model.json` (your write only), run one
   `check`, and send each failure back to the agent whose item caused it.
5. Flows and the tour: yourself, after the merge.

No `build` while subagents work. Re-dispatch only failed items.

## The contract (give it verbatim)

```
You describe ONE capability of <repo> for ultraview. Do not write any file.
Capability: id "<id>", label "<label>". Seed nodes: <ids>.
Run, from <repo>: node <skill-dir>/scripts/ultraview.mjs dossier <id> --repo <repo>
(for each seed; `show <id>` for a card). Read only what they point at.
Return ONLY this JSON:
{ "id": "<id>", "label": "<plain words>", "summary": "<1-2 sentences, each ending [path:line]>",
  "actors": ["…"], "members": ["<node ids from dossier/show output only>"], "paths": [] }
Rules: every sentence cites lines you read; no id you did not see printed;
plain words for a product owner; say what the code does today.
```

## Without subagents

Do the same units in order yourself: identical files, only slower. The
gates (`check`) do not depend on the harness.
