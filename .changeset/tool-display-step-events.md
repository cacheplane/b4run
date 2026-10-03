---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
---

Tools can export `display` (`ToolDisplay`): an icon and `running`/`done`/`sources` functions that say how a call reads to a person. The runtime evaluates it per call, streams it to AG-UI clients as `CUSTOM` `b4.step` events (`running` before the result, `completed` after; `failed` after an error result for every tool), and keeps it on the checkpointed tool message (`additional_kwargs.b4_step`). `b4 check` validates the export. The built-in workspace, memory, skill, plan and subagent tools ship labels.
