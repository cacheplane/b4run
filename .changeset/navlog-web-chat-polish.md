---
"@b4run/devkit": patch
---

The navlog template's chat dock reads like a flight-planning tool rather than developer output. Tool cards show a plain title and a one-line result summary ("Current weather (METAR) for KFCM, KDLH", "2 airports VFR"), with the raw arguments and result behind a Details button, and never show memory record ids. The transcript stays with the newest output while you are at the bottom and offers "Jump to latest" when you scroll up. The composer's message box takes the full width and grows to eight lines, with the attach, hint and Send controls in a row below it. The flight plan approval summarizes the plan in one line and offers only "Allow once" and "Deny". A restored conversation shows its plan as the Plan card instead of raw `writeTodos` JSON. Each subagent card appears under the call that started it instead of after every later message. The header gives the conversation title its own row, with a Running, Awaiting approval or Ready status.
