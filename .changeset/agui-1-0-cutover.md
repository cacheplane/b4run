---
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/devkit": patch
"create-b4-app": patch
---

Move to AG-UI protocol 1.0 (`@ag-ui/core`/`@ag-ui/encoder` 1.0.1; `@ag-ui/client` optional peer `>=1.0.1 <2.0.0`; validators at `@ag-ui/core/schemas`). Breaking for AG-UI clients: the approval grant is carried in `metadata.grant` only, on interrupts and on resume entries — the top-level `grant` a 1.0 client strips is gone. This also fixes AG-UI approval resumes under `approvals.grants`, which could never deliver a grant on 0.13.x: the 0.0.59 strip-mode schema removed `resume[].grant` before the runtime read it, so every such resume was refused. `RUN_STARTED` declares `protocolVersion: "1.0"`; a request declaring a foreign major is refused with `400 unsupported_protocol_version`. A cancelled or shut-down run ends with `RUN_FINISHED { outcome: cancelled }` instead of `RUN_ERROR`; a turn that leaves client-provided tool calls parked names them in `outcome.pendingToolCallIds`; a null route result is omitted rather than sent as `result: null`. 1.0 content parts are read as text; messages carrying media parts are refused with `422 multimodal_not_supported` until multimodal input lands; reasoning and activity history is dropped on the way in. Examples and the research scaffold pin CopilotKit 1.76.0 and `@ag-ui/client` 1.0.1 exactly.
