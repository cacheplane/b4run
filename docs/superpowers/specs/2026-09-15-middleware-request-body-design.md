# Execution middleware request body

## Problem

Execution middleware sees headers and route identity but cannot inspect the
parsed request. Applications cannot validate client selection context or apply
decision policies without building an outer HTTP adapter. Automatically merging
client state into checkpoint state would conflate untrusted input with owned
runtime data.

## Design

Add one optional `body?: unknown` field to `MiddlewareRequest`. Populate it with
a detached structured clone of the original parsed JSON at the AG-UI run and
Agent Protocol stream, wait, and resume middleware sites. GET endpoints omit it.
The unknown type requires application narrowing. Middleware continues returning
`allow(context)` or `reject(...)`; no new callbacks, dependencies, protocol
extension registry, or client-specific integration is introduced.

Keep request validation and authorization order unchanged. AG-UI extensions are
inspectable only as untrusted data; the runtime still uses its parsed protocol
input. The snapshot cannot mutate the input or resume decision through aliasing.
This is request-scoped inspection, not a checkpoint merge or durable context.

## Alternatives

- Automatic state forwarding: rejected because arbitrary client fields should
  not become owned runtime state without application validation.
- Protocol-specific adapter hooks: unnecessary public API for this requirement.
- Parsed body on existing middleware: selected because every HTTP client can
  benefit from the same inspection and validation boundary.

## Validation and scope

Test complete envelopes on all four POST sites, AG-UI unknown-field visibility,
validated context forwarding, nested mutation isolation, rejection, and unchanged
GET behavior. Run repository validation and include a patch changeset.

Structured output is separate. Existing custom tools/capabilities can host a
schema-constrained model call before an interrupt; no new agent response-schema
API is included without evidence that those extension points are insufficient.

Independent design review accepted this boundary and emphasized detached cloning
and preserving resume authorization ordering.
