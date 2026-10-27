---
"@b4run/cli": patch
---

Wait for shared run admission release before returning successful no-op or partial browser-tool callback responses. Release failures now fail the request instead of exposing a successful terminal response before ownership cleanup finishes.
