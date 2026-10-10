---
"@b4run/cli": patch
"@b4run/core": patch
---

A client's response schema now travels as AG-UI's own `forwardedProps.responseSchema` instead of a `hashbrown` body key, and the provider-facing schema name is `b4_response` (it was `hashbrown_response`). B4.run no longer reads `hashbrown`. A client that still sends `hashbrown.responseSchema` gets an unconstrained reply until it moves the schema to `forwardedProps`.

`server.agui.clientForwardedProps` now also takes a per-key allow list: an object mapping a route id, or `"*"` for every route, to `true` or the `forwardedProps` key names it accepts. For example, `{ "/chat": ["responseSchema"] }`. A key the route does not accept is refused with `422 forwarded_props_not_allowed`, and the message names it. The array form keeps its meaning (any key on the listed routes). The setting is now shape-checked at boot, so a malformed value fails on startup instead of reading as closed. A route's `output.structuredOutput` capability is now `true` only where the route accepts `responseSchema`.
