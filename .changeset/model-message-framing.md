---
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/ag-ui": patch
---

Keep concurrent nested model output in separate AG-UI assistant messages. Carry
model invocation identity through runtime tokens and live-turn snapshots, and
close each message when its model finishes. Legacy anonymous tokens and raw SSE
string payloads remain supported.
