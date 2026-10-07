---
"@b4run/ag-ui": patch
---

The activity kit's framework-free rules move to `@b4run/ag-ui/view` so every kit renders from one implementation: the summary line (`summaryLine`, `nestedSummaryLine`, `formatDuration`), step and subagent wording (`stepMeta`, `groupMeta`, `subagentMeta`, `reasoningLabel`, …), the detail text (`stepDetailText`, `prettyValue`, `capDetail`), the approval card's text (`approvalPayload`, `scopeLine`), the open/closed rule (`observeDisclosure` and friends), the no-flash and elapsed clocks (`noFlashRemaining`, `sampleElapsed`), and the glyphs as data (`STEP_GLYPHS`, `CHEVRON_GLYPH`). `@b4run/ag-ui/react` renders from them and still exports `summaryLine`, `formatDuration`, `approvalPayload` and `scopeLine`. In `styles.css`, the nested subagent turn's two rules match it as a descendant of `.b4-step__children` rather than a child, which selects the same elements in the React kit.
