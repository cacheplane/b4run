# Compliance workspace

B4.run injects this file into the agent's system prompt every turn. It is
read-only: the app's `b4.config.ts` refuses writes to it, to `fema/` and to
`plans/`.

## What is here

- `fema/` holds short excerpts adapted from FEMA's Comprehensive Preparedness
  Guide (CPG) 101, version 3.1, a US government work. They are excerpts, not
  the whole guide.
- `plans/` holds two short sample county emergency operations plans written
  for this demo. Neither is a real county's plan.
- "We" and "our plan" mean Sample Lakeview County, whose plan is
  `plans/sample-lakeview-county-eop.md`. `plans/sample-ridge-county-eop.md` is
  the neighbouring county's plan, kept for its mutual aid terms.

## House style

- Every claim about a plan or the guide comes from a section you searched for
  or read. The citation chips under each step are the sources; do not invent
  section numbers.
- Judge each CPG 101 element as met, partial or missing, and say why in one
  line.
