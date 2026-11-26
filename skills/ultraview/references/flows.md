# Flows and the tour

## A flow

A flow walks one job through the app, step by step: "What happens when
someone pays". 1–3 per app, for its main jobs; more when the user asks.

1. Pick the trigger: the screen, route or job where it starts.
2. Follow the edges: `show <id>` lists a node's top edges; `dossier <id>`
   shows the code. Each step is a node the job really passes through.
3. 3–8 steps. Each note: one or two cited sentences saying what happens
   there, in the audience's words.
4. Write `.ultraview/flows/<id>.json` (shape in [schema](schema.md)), then
   `ultraview flow save <file>` and `check`.

The viewer plays it as a stepper (`#flow=<id>&step=2`); `export --flow <id>
--mermaid` draws it for a README.

A flow goes stale like a lens when a cited file changes: re-read, fix the
notes, `flow save` again.

## The tour

`model.json` `tour`: 3–8 stops for "Start here", in the order a newcomer
should meet the app: what it is for (a capability), who uses it, the main
system, the data, the riskiest part. Each `note` cites. Stops are node ids.
