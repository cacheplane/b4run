---
"@b4run/cli": patch
---

Log the real cause of a store failure. A Postgres connection the WebSocket driver could not open used to reach the runtime log as `[object ErrorEvent]`; the runtime now renders the message, code and nested cause chain of whatever was thrown, and the generated `stores.mjs` reports a store initialisation failure once with the store kind and a credential-free connection target. `@b4run/cli/fetch` exports the `serializeError`, `formatErrorChain`, `errorStackOf` and `describeConnectionTarget` helpers behind it.
