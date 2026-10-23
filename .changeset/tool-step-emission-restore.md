---
"@b4run/core": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
---

Emit and persist versioned tool steps with epoch timestamps, stable source ids, and explicit failures. Start execution updates only after permission and argument gates allow the tool body. Carry final steps in AG-UI result metadata, restore v1 and legacy steps with producer timing, and exclude provider tool results from inbound conversation.
