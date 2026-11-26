# Writing for humans

## Plain language

- Labels: what it is for, 1–4 words. "Main server", "Placing an order",
  "Order history". Not "Shop API (Express)", "OrderController", "CRUD".
- Summaries: one or two sentences, subject first, present tense, what it does
  today. "Customers list their orders, open one, or cancel it."
- Say surprises plainly: "Cancelling does not delete the order: its status
  goes back to PENDING." Say placeholders plainly: "Returns the id it was
  given; it does not read the database yet."
- No invented numbers, users, reasons or plans. If the code does not show
  why, do not say why.
- Technical words only when the audience is developers; explain the
  unavoidable ones in the glossary.

## Citations

- Every sentence ends with at least one `[path:line]` or `[path:start-end]`
  (several allowed). Paths are repo-relative, as the index prints them.
- "Every sentence" is literal: the summary or opening line, each lead-in,
  transition and conclusion ("In short, …", "To sum up, …"), the line that
  introduces a list, and each list item, as much as the main facts.
- What `check` counts as a sentence: each paragraph and each list item is
  split after `.`, `!` or `?` when a space and a capital (any script), a
  digit, `¿`/`¡` or a markup opener follow; a paragraph or item with no such
  break is one sentence, full stop or not. `#` headings, code fences and
  tables are skipped. A sentence of 15 characters or fewer is not checked.
- A bold label (`**How it works.**`, `**In short:**`, alone on its line or
  not) is part of the sentence it introduces, so that sentence's citation
  covers it; a bold label with nothing after it is checked as a sentence.
  Bold text inside a sentence is not a label: `It **deletes every cart.**
  Then …` is two sentences.
- The opening summary ("In short: …", "En bref : …", "En resumen, …", bold
  or not) is the sentence most often left uncited: end it with the
  citation(s) of the main fact(s) it sums up, before its full stop, even
  when the same lines are cited again below.
- Correct: `**In short:** a nightly job deletes expired carts, except those
  with a pending payment [src/jobs/carts.ts:12-30] [src/jobs/carts.ts:18].
  It runs at 02:00 [src/jobs/schedule.ts:4].` Refused: the same summary
  with no citation, or a closing `In summary, carts never pile up.`
- Cite the lines that show the claim, not the top of the file. A range for a
  block, one line for one fact.
- `check` proves each citation resolves to real lines and each sentence has
  one; it cannot prove the lines say what you claim. Re-read the lines.
- A sentence with nothing to cite is a sentence to drop.

## Audience

- `everyone` (default): the viewer opens in its Business audience: the
  Business, Systems and Modules levels, technical labels hidden. Write every
  summary so a product owner can read it.
- `developers`: it opens in the Developer audience, which adds the Files and
  Symbols levels; names of functions and routes are fine.
- Both share one model: prefer plain words even for developers.
- In the chat, report like the map: plain words first, ids and paths after.
