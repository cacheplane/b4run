---
"@b4run/ag-ui": patch
---

The activity kit's step detail reads as a person would, not as raw JSON: an object's arguments and results become key/value rows (one nested level as dotted keys), a short list of objects becomes one group of rows each, a string or scalar is plain text, and anything deeper stays pretty JSON. "Show raw" opens the original of any side shown as rows. `stepDetailView` (`@b4run/ag-ui/view`) is the framework-free classifier both kits render from. Each block now scrolls on its own, so a long input no longer hides the result; a settled subagent shows its steps straight away instead of repeating the subagent row's summary; the disclosure chevron is centred on a step's first line; and source chips ellipsize instead of overflowing the column.
