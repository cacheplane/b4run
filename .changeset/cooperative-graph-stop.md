---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/langgraph": patch
"@b4run/cli": patch
"@b4run/ag-ui": patch
---

Make ordinary Stop cooperative for native graph runs: finish the active superstep and synchronous checkpoint writes, retain thread and request ownership until settlement, and prevent fresh input from replaying pending old actions. Keep hard aborts separate, preserve natural completion and independent errors, and report an observed Stop consistently through Agent Protocol and AG-UI. Opaque route contexts receive an optional separate stop signal; tool work and nested calls remain part of their awaited parent step.
