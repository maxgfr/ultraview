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
