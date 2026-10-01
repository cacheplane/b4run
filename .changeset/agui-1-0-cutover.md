---
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/devkit": patch
"create-b4-app": patch
---

Move to AG-UI protocol 1.0 (`@ag-ui/core`/`@ag-ui/encoder` 1.0.1; `@ag-ui/client` optional peer `>=1.0.1 <2.0.0`; validators at `@ag-ui/core/schemas`). Approval grants (new in this release) travel over AG-UI in `metadata.grant` only, on interrupts and on resume entries; a 1.0 client strips a top-level `grant` in both directions. Breaking for AG-UI clients relative to 0.13.0: a cancelled or shut-down run ends with `RUN_FINISHED { outcome: cancelled }` instead of `RUN_ERROR`; a request declaring a foreign protocol major is refused with `400 unsupported_protocol_version`; a null route result is omitted rather than sent as `result: null`; messages carrying image, audio, video or document parts are refused with `422 multimodal_not_supported` until multimodal input lands. `RUN_STARTED` declares `protocolVersion: "1.0"`; a turn that leaves client-provided tool calls parked names them in `outcome.pendingToolCallIds`; 1.0 content parts are read as text; reasoning and activity history is dropped on the way in. Examples and the research scaffold pin CopilotKit 1.76.0 and `@ag-ui/client` 1.0.1 exactly.
