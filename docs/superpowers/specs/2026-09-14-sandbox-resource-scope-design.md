# Stable application scope for sandbox resources

Date: 2026-09-14
Status: independent spec review passed; awaiting user review of the concrete API

## Problem and boundary

Docker and Kubernetes currently derive resource names from a logical thread ID.
Two applications sharing a Docker daemon or Kubernetes namespace can therefore
address the same resources. Normalization also merges distinct identifiers:
Docker replaces punctuation with underscores, and Kubernetes lowercases and
replaces punctuation. Long Kubernetes identifiers receive a hash suffix, but
short identifiers still collide under normalization.

This increment adds opt-in stable resource addressing. It is the first part of
the library-adoption lifecycle work, not completion of durable initialization or
verified resource ownership. It does not yet remove code-fixer's seeding and
cleanup wrappers. Those require separate persistent-state and lifecycle designs.

## Alternatives

1. **Provider options (recommended):** add the same `scope` option to the two
   reference providers and share one internal identity function. Application
   configuration stays direct and logical thread IDs remain intact.
2. **Provider decorator:** rewrite thread IDs before calling any provider. This
   works for third-party providers, but changes the identity observed by their
   callbacks and complicates wrapper composition and debugging.
3. **Automatic application scope:** derive scope from app root or deployment
   metadata. Moving a checkout or deploying a built artifact could then silently
   select different persistent storage. Reject implicit derivation.

## Public API

Add `readonly scope?: string` to `DockerSandboxOptions` and
`KubernetesSandboxOptions`. For example:

```ts
const provider = dockerSandbox({
  image: "my-code-fixer-sandbox:1",
  scope: "code-fixer-development",
})
```

The application chooses a stable installation/environment identifier. Replicas
that intentionally share thread storage use the same value; independent apps,
environments, and disposable eval attempts use different values. Do not derive
it from a PID, cwd, or random value on ordinary runtime startup. No new required
environment variable or provider wrapper is introduced.

Sharing a scope permits addressing the same storage; it does not add
cross-process coordination or make concurrent replica access safe. Existing
provider lifecycle and concurrency behavior remains unchanged.

An omitted scope preserves the current names and labels exactly. Explicit empty
or whitespace-only values fail at provider construction before provider I/O.
Other strings are opaque, case-sensitive values: no trimming or normalization.
TypeScript remains the type boundary; runtime validation also rejects non-string
values other than undefined. Image and execution policy are not identity inputs:
changing them must not select a different workspace volume.

## Resource addressing

For scoped operation derive a lowercase resource token from SHA-256 of the UTF-8
encoding of `JSON.stringify(["b4-sandbox-scope-v1", scope, threadId])`.
Use the first 40 hexadecimal characters (160 bits). This avoids delimiter
ambiguity and fits the existing Kubernetes resource-token length without further
truncation. Freeze the domain tag, encoding, and truncation with known vectors.

Use that token wherever the provider currently uses its normalized thread ID:
Docker container/volume names and its thread label; Kubernetes Pod/PVC/network
policy names, thread labels, and network policy selectors. Preserve current name
prefixes and the Kubernetes managed-by label. Do not hash the token again.
Both providers use the same helper; its unscoped branch retains each provider's
existing normalization behavior.

Keep logical `threadId` unchanged in handles, manager caches, lifecycle
coordination, and author-facing tool context. Resolve the resource token
consistently for acquire, reattachment, release, destroy, and recovery paths.
Existing Docker policy identity labels and execution leases continue unchanged.

This is collision-resistant addressing, not authentication or proof of ownership.
An actor with the same Docker/Kubernetes control-plane privileges can still
create or manipulate these names. An unscoped caller could also deliberately
choose a thread ID equal to a scoped token. This increment does not assert
isolation from such callers, add adoption checks, or broaden cleanup privileges.

## Compatibility and retention

Existing installations remain unscoped until explicitly configured. Adding or
changing a scope selects a different resource address; it does not migrate,
delete, or fall back to legacy volumes. Document this as an explicit storage
cutover: preserve the old configuration to access/export old workspaces, and
verify a backup/import procedure appropriate to the deployment before switching
existing durable threads. No automatic migration command is part of this change.

Kubernetes's current reaper selects the managed-by label and compares PVC names
against actual Pod claim references. It does not parse thread identifiers. Keep
those labels and references consistent, so scoped resources retain the same
retention policy. Scope is not a retention class: released PVCs remain subject to
the configured reaper TTL. Do not add a sweeper or change the chart in this slice.

## Acceptance and verification

- Fixed vectors prove stable addressing across provider instances and process
  restart; use a fresh process for at least one vector assertion.
- Identical scope/thread pairs produce identical tokens in Docker and Kubernetes.
- Different scopes with the same thread and normalization-colliding thread pairs
  within one scope produce distinct resources. Cover case, punctuation, Unicode,
  long IDs, and strings that would collide under delimiter concatenation.
- Provider tests assert scoped names on acquire, reattach, release, destroy, and
  Docker recovery; Kubernetes selectors match scoped Pod labels and PVC mounts.
- Handles retain the original logical thread ID. Preflight and policy behavior
  are unchanged. Invalid scope fails before any mocked provider call.
- Existing unscoped provider tests continue to pass without rewriting their
  expected resource names. Reattachment with a new provider instance preserves
  workspace edits; destroying one scope leaves the other scope's storage intact.
- Add Docker and Kubernetes gated integration coverage for that last lifecycle
  boundary, and report explicitly when the necessary infrastructure is unavailable.
- Update the sandbox overview and both provider API docs, with the cutover and
  trust boundaries above; add a patch changeset for `@b4run/sandbox`.
- Run focused tests/types, full build before dist consumers, docs checks, and the
  repository validation gates before merge. No paid model run is needed.

## Next lifecycle design

Durable initialization must record version and completion outside agent-writable
files, coordinate concurrent attempts, and fail clearly after interrupted setup.
It must never silently overwrite an edited retained workspace when the process
restarts or the seed version changes. Verified ownership and cleanup must address
provider errors and active processes before replacing the app's ownership log.
Scoped names provide a stable address for that work, not its completion signal.
