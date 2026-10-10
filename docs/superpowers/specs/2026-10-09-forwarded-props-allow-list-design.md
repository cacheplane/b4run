# Response schema over `forwardedProps`, with a per-key allow list

Date: 2026-10-09
Scope: `@b4run/cli`, `@b4run/core`, `@b4run/ag-ui`, the navlog example and template
Builds on: #1014

## Goal

A client's response schema travels as a standard AG-UI field, not a
library-named one, and B4.run decides which `forwardedProps` keys each route
accepts.

## Decisions

1. **Wire format.** The client sends `forwardedProps: { responseSchema }`. B4.run
   no longer reads `hashbrown`, `ui: true` or any other library key. The
   provider-facing schema name becomes `b4_response`.
2. **`server.agui.clientForwardedProps` takes a key allow list.** The setting is
   one of:
   - an array of route ids (today's form): those routes accept any key;
   - an object mapping a route id, or `"*"` for every route, to `true` (any
     key) or an array of key names.

   A route's allowed keys are the union of its own entry and `"*"`'s. `true`
   from either side allows every key.
3. **Rejection.** A non-empty `forwardedProps` with a key the route does not
   allow is refused with `422 forwarded_props_not_allowed`, and the message
   names the keys and the setting. An empty `forwardedProps` stays accepted.
4. **Interpretation.** An allowed `responseSchema` is bound on the root model.
   It is never ignored: a malformed one gets `invalid_response_schema`, and a
   provider or route kind that cannot bind it gets
   `response_schema_not_supported`. Other allowed keys are accepted without
   being acted on, as today.
5. **Shape validation.** `B4Config` has no runtime schema, so the boot checks
   the setting and refuses anything other than the two forms above. Unlike
   today, it no longer quietly reads a non-array as closed.
6. **`B4HttpAgent`.** `responseSchema` is merged into each run's
   `forwardedProps`, keeping any keys the caller set.
7. **Navlog.** Navlog's `b4.config.ts` sets
   `clientForwardedProps: { "/navlog": ["responseSchema"] }`. The template
   mirrors it.

## Trade-off

Hashbrown's own AG-UI client sends `hashbrown.responseSchema`. B4.run will not
honor it until hashbrown sends `forwardedProps.responseSchema`, which is a
possible upstream change. `B4HttpAgent` covers the CopilotKit path.

## Delivery

One PR stacked on #1014. It covers tests for the policy, validation, reader,
handler and client, plus the docs (`ag-ui.mdx`, `configuration.mdx`, the API
pages, and the evals and testing mentions), the lastmod manifest, and a patch
changeset.
