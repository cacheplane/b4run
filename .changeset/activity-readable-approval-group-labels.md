---
"@b4run/ag-ui": patch
"@b4run/devkit": patch
---

The approval card lists a tool call's arguments instead of printing their JSON: when the args preview is a JSON object, each key is a row, a nested object's keys read `parent.key`, anything deeper is compact JSON, and a value past 80 characters is cut with the whole of it a click away. Other payloads (a command, a subagent gate, a preview the server cut short) print as before. `approvalArgsRows` (`@b4run/ag-ui/view`) is the shared helper both kits render from, with its `ApprovalArgRow` type and `MAX_APPROVAL_ARG_CHARS`.

A merged run of one tool's calls is phrased from the calls' own labels when they share leading words and end in a short name: "Looked up KSTP" and "Looked up KRST" merge as "Looked up KSTP and KRST", three name all three, and more name two and count the rest. A trailing parenthetical is left out. An app's `group` label and the built-in tools' wording still come first, and labels that do not fit still read "Used X n times". `phraseGroupLabel` (`@b4run/ag-ui/view`) is the rule.

The navlog template's `lookupAirport` puts an airport's details in parentheses, so its calls merge by name, and drops its `group` label.
