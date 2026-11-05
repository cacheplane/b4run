# Agent Protocol Store and memory review design

Date: 2026-11-05

Status: Approved by Brian on 2026-11-05 after independent spec review.

Scope: the Store and memory-review section of the coordinated B4/b4app Agent Protocol release.

B4 will serve ordinary documents through the five standard Store operations and
project managed memory through the same namespace/key interface. Memory remains
in its authoritative domain backend. Approval is the single additional Store
operation because it can reconcile several records and return a different
canonical key. This design replaces the old memory HTTP routes directly.

## 1. Contract and boundaries

The normative baseline is Agent Protocol OpenAPI 0.1.6 at
[`455acf2eb2c55c634350f4c6a8da117d0ecfa7b1`](https://github.com/langchain-ai/agent-protocol/blob/455acf2eb2c55c634350f4c6a8da117d0ecfa7b1/openapi.json).
B4 policies below specify behavior where that schema is silent; they are not
corrections to upstream. Additional conditional/review headers, response codes
and capability fields are declared B4 extensions. Keep the original upstream
document intact and maintain the B4 overlay separately.

| Method and path | Contract |
| --- | --- |
| `GET /store/items` | Read one Item by namespace/key; 200 Item or non-disclosing 404. |
| `PUT /store/items` | Upsert an ordinary object value at the requested address; 204. |
| `DELETE /store/items` | Delete the addressed item using a JSON body; 204 or 404. |
| `POST /store/items/search` | Return the standard `{items}` object with authorized filtering and pagination. |
| `POST /store/namespaces` | Return the standard array of namespace arrays. |
| `POST /store/items/approve` | B4 extension for transactional managed-memory approval. |

Remove `GET /memory/candidates` and the old candidate approve/reject routes.
There are no aliases, compatibility handlers or additional review/receipt
endpoints. Store access does not expose journals, runtime receipts, approval
grants, execution leases or sandbox control records.

## 2. Addresses and representation

Generic namespaces are arrays of literal strings. Keys are literal strings,
unique within their namespace. Preserve empty components, empty keys, case and
Unicode exactly where the pinned schema permits them. Do not join paths with a
delimiter for storage identity. Prefix/suffix matching compares whole array
components; `['a']` does not match `['ab']`.

GET uses repeated query parameters in array order, for example
`?namespace=profiles&namespace=alice&key=preferences`. Decode each component once.
Omitted GET/DELETE namespace selects the root namespace `[]`, never global lookup.
PUT requires namespace, key and an object value as specified upstream. Approval
requires an explicit namespace and key. Malformed address types return 422.

Managed memory uses this exact projection:

| Item field | Authoritative source |
| --- | --- |
| `namespace` | `['b4', 'memory', record.namespace]` |
| `key` | `record.id` |
| `value` | The complete public MemoryRecord object. |
| `created_at`, `updated_at` | `record.createdAt`, `record.updatedAt` |

The serialized memory scope is one opaque component, including its existing
percent escapes. Do not split it into dimensions or decode it again. Reserve
the entire `['b4','memory']` prefix for managed dispatch; malformed addresses
inside that prefix cannot fall through to generic storage. The prefix itself
is not an item namespace. Generic data outside that prefix supports independent
equal keys in different namespaces.

Preserve kind, content, data, source, confidence, tags, status, supersedes,
effectiveAt and expiresAt. Duplicated value ID/scope/timestamps agree with the
Item address and envelope. Keep embeddings and internal revision/receipt state
private. The projection is not a second record copy. An exact-address memory
lookup must verify the stored namespace even when the backend API takes only ID.

## 3. Storage and authority

The Store service dispatches generic documents to a generic Store adapter and
managed namespaces to the existing memory backend adapter. Built-in generic
storage supports SQLite and Postgres; managed memory supports SQLite and
Postgres/pgvector. This does not require generic documents to use vector storage.
Custom adapters must implement the same declared capability/consistency contract.

Resolve the principal once. Authorize read, write, delete, review, search and
namespace enumeration separately. Preserve server-resolved workspace/route,
tenant/user/agent ownership, shared scopes, anonymous behavior, review-all
authority and Navlog's owner-only review restriction. A namespace is an address,
not proof of ownership. Validate managed scopes against canonical serialization
and server policy; the permissive existing parseNamespace helper alone is not
an authorization validator. Preserve byte-exact existing valid scopes.

Use an explicit server StoreAccessPolicy for generic data; it receives the
resolved principal, operation and complete selected address or collection query.
Configured policy always applies. Without that policy, an app with authentication
configured denies generic HTTP Store access by default; an app with no
authentication preserves the existing open-app convention. Managed memory still
uses the existing scope/review policy. Review-all memory authority grants no
generic Store authority. Collection policy must supply or evaluate authorized
scope/item constraints before the final page window, never after it.

Apply authorization before filtering/page windows and namespace aggregation.
Unauthorized and missing item addresses both return 404. Reject collection
access with 403 only when the caller lacks collection authority altogether;
otherwise return the authorized subset, possibly empty. Do not expose hidden
counts, keys, namespace names or review outcomes. Authentication failures keep
the app's established authentication behavior. Authorization runs again before
returning an idempotent approval receipt.

## 4. Generic CRUD and managed writes

Generic PUT replaces the complete object value, rather than JSON-merging it.
Creation sets server UTC timestamps. Updates preserve created_at; a changed
value advances updated_at. Identical JSON-value PUT is a no-op, preserving both
timestamps. Object member order does not make a generic value different; array
order does. PUT never remaps the requested key through memory reconciliation.
Success has no body. DELETE has the pinned JSON body and no success body.

Item GET returns a strong opaque ETag for the effective Item representation.
An optional If-Match on PUT/DELETE requires the addressed revision still to
match, returning 412 without mutation otherwise. No precondition is required
for ordinary generic clients: unconditional upsert/delete remain available when
authorized. Document these conditional HTTP behaviors in the B4 overlay and
expose ETag/required request headers through the existing CORS mechanism.

Raw PUT into managed memory is denied by default, including for reviewers.
An app may explicitly supply a schema-constrained candidate-write policy;
implementing a new candidate-editing UI is outside this release. Such a policy
cannot promote records, mutate protected active facts, change scope/identity,
forge provenance or bypass the shared domain coordinator. The built-in release
needs no raw managed PUT permission to support standard generic Store CRUD.

Runtime auto/ask/candidate/off write modes, CLI commands and existing memory
tools retain their intended authority and kind-specific behavior through the
same mutation service. Semantic approval reconciles; episodic/reflection
approval activates without semantic reconciliation. Procedural writes remain
explicitly unsupported until implemented independently. Read schemas preserve
any existing procedural records without advertising write support.

Guard runtime data-derived ID collisions inside the coordinator. A candidate
write of an already-active identical fact returns that existing fact unchanged,
with an honest already-active outcome and no new pending candidate. It cannot
demote active memory. A proposal whose derived address belongs to a superseded
record creates a fresh candidate ID, leaving that historical record untouched.
Likewise auto/ask returning from fact A through B to A allocates a fresh record
when its derived base ID names superseded A; it supersedes B through the usual
authorized operation. Never overwrite a different scope/kind/data on a hash
collision. Allocate a fresh ID for that operation instead. Persist the selected
ID with the stable logical tool-invocation/mutation identity so a retry of the
same admitted operation cannot allocate another record. Existing pending
candidates may be updated only under applicable runtime candidate authority or
an explicit HTTP candidate-write policy, with a revision change; old review
preconditions then fail. This fixes accidental
status reversal while preserving review, append and legitimate A-to-B-to-A use.

## 5. Search and namespaces

Search is document filtering, not vector/semantic retrieval. Preserve the
separate runtime recall/ranking path. Adopt these explicit B4 filter semantics:

- Omitted/null filter or `{}` matches all authorized items under the prefix.
- Filter keys name literal top-level Item.value properties and combine with AND.
- Values use type-sensitive JSON equality; object key order is immaterial,
  arrays are ordered, and null differs from an absent property.
- Dotted keys are literal keys, not paths. Operator-prefixed keys such as `$and`
  are rejected with 422 in this release, rather than partly interpreted.

Thus `{status:'candidate'}` selects memory candidates. Do not add public vector
query parameters or reinterpret a string filter as full-text search.

Search order is updated_at descending, then namespace components in bytewise
lexicographic order, then key bytewise ascending. Namespace listing is bytewise
lexicographic by components, with a shorter equal-prefix namespace first.
Use the approved defaults: item search limit 10/offset 0; namespace listing
limit 100/offset 0. Reject non-integral/negative limits or offsets; limit zero
returns an empty page. Do not invent the agent-search 1–1000 bound for Store.
Operational request budgets fail explicitly rather than silently shortening a
successful page or imposing a hidden record scan ceiling.

Omitted/null/empty search namespace_prefix selects all authorized namespaces.
For namespace listing, apply prefix and suffix to actual nonempty authorized
namespaces, truncate each path to max_depth when supplied, deduplicate, sort,
then paginate. max_depth zero yields `[[]]` if any authorized namespace matches,
or `[]` otherwise. Listing a virtual parent never exposes an unauthorized leaf.

Each page is a deterministic live read, not a frozen multi-request snapshot.
Concurrent writes can move offset seams. Clients deduplicate by full address,
refresh after mutations, and never equate one default page with a full list.
Do not promise snapshot pagination without a separately designed protocol.
Merge generic/managed authorized streams before applying the global page window;
do not paginate each store and concatenate. An adapter timeout fails the read
rather than reporting another adapter's partial results as complete. No public
total count or continuation wrapper is added to the pinned response shapes.

## 6. Review revision and response

Approval acts on the candidate the reviewer actually inspected. The B4 extension
request is `{namespace, key, if_revision}`, where if_revision echoes the opaque
ETag from an authorized Item GET. Missing revision is 422; a changed revision is
409 `item_changed`. This is a declared approval-body extension; do not describe
it as a field required by Agent Protocol. Search retains its standard shape.

Navlog obtains the current Item/ETag before review. If it differs from the card
already shown, display the changed candidate and require a new decision; never
silently approve the new content. A reject action uses conditional standard
DELETE with that ETag. A concurrent approval therefore cannot turn a stale
reject click into deletion of a newly active record. Unconditional authorized
deletion remains a deliberate latest-record operation, not a candidate-only
guard inferred from the old reject handler.

Maintain a private monotonic revision/generation independent of timestamps and
public IDs. Existing remember IDs are data-derived and may recur; old ETags must
not match a recreated address, even when content or wall-clock time repeats.
Changing effective review policy also invalidates a pending review precondition.

Successful approval returns 200 with:

```typescript
{
  item: Item, // canonical item, possibly a different key after deduplication
  action: 'activated' | 'superseded' | 'deduped',
  superseded: Item[],
  removed: { namespace: string[], key: string }[],
  replayed: boolean
}
```

These are the complete affected sets for this operation, not a new generic Store
response wrapper. Activation retains the candidate key. Supersession activates
it and links/demotes the predecessor. Deduplication removes the candidate and
returns the existing canonical item without refreshing that survivor's recency.
item and superseded contain snapshots after the transaction's changes; removed
contains the deduplicated candidate address only, or is empty. A receipt replay
returns those original commit snapshots, not a claim about their present status.
Preserve the existing classification's configured identity keys, missing/null
normalization and exact data comparison; do not change identity/equality policy
incidentally as part of protocol conversion. Reconcile within namespace and kind.

Resolve policy from server-owned route configuration/static build artifacts.
Use subject/predicate only when the policy intentionally selects that default;
failure to load a declared custom identity policy fails before mutation.

## 7. Atomicity and conflicting writers

All supported managed mutation paths participate in one backend transaction and
namespace serialization domain: approval, rejection/deletion, candidate writes,
runtime auto/ask writes, CLI mutations and pruning/consolidation writes. Merely
wrapping HTTP approval while runtime writes retain the old inline race is
insufficient. Keep dependencies acyclic by injecting a pure mutation-service port
into core capabilities rather than importing Node-backed memory entrypoints.

Within the lock, re-read exact address/revision and eligibility, evaluate the
complete matching active identity set, write all affected records/indexes and
the operation receipt, then commit. Never hold a database transaction across
human approval, provider inference or embedding network calls. Ask-mode memory
supersession inspects under a short transaction, releases it to ask, then rechecks
the same protected proposal before mutation; changed work requires fresh approval.
Re-evaluate current permission policy for changed work: a previous once decision
cannot transfer, while a valid remembered Always rule keeps its configured scope
and normal headless/deny behavior. Do not force an interactive prompt where
current policy explicitly allows the newly evaluated action.

Use a backend operation that owns the transaction, not nested calls to public
store methods which open their own transactions. SQLite uses writer transaction
serialization; Postgres uses transaction-scoped namespace coordination with
re-reads after acquiring it. Retries for busy/serialization conflicts are bounded
and replay only uncommitted database work, never external actions or user answers.
Other processes must participate; an in-memory mutex is insufficient.

Replace approval's 10,000-row ceiling and auto's 50-row identity scan with a
complete backend identity lookup/scan in the serialized transaction. No identity
match may be missed because of a page cap. If inherited data already has several
active matches, return 409 `memory_invariant_conflict` before mutation rather than
arbitrarily choosing one or silently repairing user data. Under valid input,
committed semantic mutations leave at most one active fact per namespace/kind/
configured identity. Unsupported custom coordinators fail before writes and
cannot advertise transactional review. Direct external SQL or application code
deliberately bypassing the managed service is outside this guarantee.

Approval versus DELETE uses the same domain. If deletion wins, approval is 404.
If approval wins, a stale conditional rejection is 412. Another first-time
approval of a now-active record is 409 `not_candidate`; an address removed by
deduplication is 404 unless a matching accepted-request receipt is recovered.
Failures before commit expose none of the multi-record transition. Failure after
commit is recovered by its receipt, not by a second reconciliation.

## 8. Approval retries

Support optional `Idempotency-Key` on the B4 approval extension. B4 review clients
persist one key before sending an intended review and reuse it only for that
exact namespace/key/revision. Fingerprint the normalized request and policy
context; scope the key to authenticated security domain/reviewer and operation.
Authorization precedes receipt lookup. A matching accepted request returns its
original committed outcome with replayed=true; it executes no mutation. Reuse
for a different request is 409 `idempotency_conflict`.

Commit receipt and domain changes atomically. Retain full approval receipts for
seven days by default, configurable and advertised. Their item snapshots describe
the original commit; clients refetch current canonical resources after recovery.
Before checking a now-stale candidate revision, check for this authorized exact
receipt, so an acknowledgement lost after deduplication remains recoverable.

After receipt expiry, clients refetch/reconcile rather than blindly repeat an
old review. Revision/generation checks continue preventing stale approval after
address reuse; expiry must not reset item revisions. Without an idempotency key,
normal eligibility/revision checks prevent repeated mutation but do not promise
recovery of a deduplication outcome whose original response was lost. Generic
PUT/DELETE do not gain a required B4 idempotency header.

## 9. Errors, discovery and operations

Use the approved top-level ErrorResponse `{code, message, metadata?}`. Preserve
upstream success and validation shapes; declare added B4 errors in the overlay.

| Condition | HTTP behavior |
| --- | --- |
| Malformed address/body/filter/pagination or missing approval revision | 422, except GET errors explicitly classified as 400 by the pinned contract. |
| Missing/inaccessible addressed item | 404 with indistinguishable content. |
| Disallowed raw managed write or missing collection/review authority | 403, without record disclosure. |
| Failed conditional PUT/DELETE | 412, after authorization. |
| Stale approval, non-candidate, invariant violation, idempotency conflict | 409 with the corresponding code above. |
| Retryable backend contention exhausted or required store unavailable | 503 with safe retry diagnostics. |
| Unexpected failure | 500 with redacted diagnostics. |

Expose a versioned `run.b4.store` capability on authorized Agent resources. It
describes standard Store availability, top-level equality filters, conditional
CRUD and, when enabled, managed prefix, approval schema/version and receipt
retention. Native AG-UI capability objects remain in their previously selected
separate carrier. Capability claims must reflect boot-resolved adapters and
authority; no Store-specific discovery endpoint is added.

Required Store/coordinator readiness contributes to the already-approved readyz
contract. Persistent storage is required for advertised durable writes/receipts;
an isolate-local map is not an edge implementation. Concrete deployment profiles
and global quotas belong to the remaining topology/retention section. Generic
Store items have no automatic TTL by default. Existing explicit memory expiry/
prune policies remain domain policy and participate in mutation coordination.
Thread deletion/rollback does not implicitly delete Store records.

## 10. Coordinated consumers and acceptance

B4 packages need a generic Store contract/SQLite/Postgres adapters, managed
projection, pure transactional mutation service, HTTP handlers, protected
discovery and typed conformance fixtures. Replace old memory HTTP decoders and
fixtures rather than leaving both dialects. Update CLI mutation paths and core
remember/consolidation entrypoints so concurrency is enforced across all writers.

Navlog keeps candidate cards, tags/confidence, outcome messages, refresh/error
behavior and owner restrictions. Its proxy validates method, body/address,
managed prefix and identity forwarding for standard Store operations. It must
not blanket-allow `/store/*`. Add revision hydration/conditional rejection and
approval receipt retries. Preserve direct generic Store users' standard shapes.

b4app updates shared wire/error/discovery fixtures for this contract. Do not add
a new memory-review UI solely for this refactor. Document Store behavior on the
B4 website and reference the full coordinated release's compatibility baseline.
Existing data treatment and release sequencing remain separate decisions; this
design authorizes no wipe or migration compatibility layer.

Acceptance must cover:

- Pinned schema validation for all five standard operations and explicit overlay
  validation for approval, headers, capabilities and added errors.
- Namespace round trips, root omission, repeated query parameters, equal generic
  keys across namespaces, reserved-prefix dispatch and exact memory addresses.
- Lossless values/timestamps, generic replacement/no-op writes, all filter cases,
  namespace depth/dedup, cross-adapter sorting and authorized multi-page reads.
- Scope/anonymous/shared/reviewer behavior, forged namespaces, lookup denial,
  managed PUT protection and Navlog proxy/body/header rules.
- SQLite and Postgres/pgvector race tests for approval/approval, approval/delete,
  auto-write/review, ask revalidation and prune/consolidation; include more than
  the old scan caps and pre-existing invariant conflicts.
- Failure injection before every multi-record commit boundary, lost-response
  receipt recovery, expiry, changed request/key reuse, recreated data-derived IDs,
  active/superseded candidate collisions and A-to-B-to-A history, no duplicate
  supersession links and preserved dedup recency/derived indexes.
- Real Navlog review flows through the standard Store surface, plus the existing
  meaningful memory ranking, reconciliation and CLI behavioral tests.

Run the repository's required validation lanes when implementing the coordinated
change. This design does not claim a completed implementation or passing runtime
validation.

## 11. Evidence and rejected alternatives

Source baseline: B4 `c1e1796556d0863da735e47822014bafa015ef3f` and b4app
`e15c113d4d8d5fca17475b42f34cbef7914791d4`.
Relevant pinned B4 sources are memory `types.ts`, `namespace.ts`, `reconcile.ts`,
`sqlite-store.ts`; memory-pgvector `pgvector-store.ts`; core built-in `memory.ts`;
CLI `memory-handler.ts`; and the memory endpoint/scope/reconciliation tests.
The current source has neither transactional reconciliation nor complete identity
scans; those are explicit requirements of this design.

Database mechanisms follow [SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html)
and [Postgres transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).
Conditional CRUD uses [HTTP validators](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match).
These sources support implementation mechanisms, not the B4 policy choices.

Rejected alternatives are a second copy of memory documents, arbitrary active
memory mutation through generic PUT, client-side approval reconciliation,
process-local review locks, silent scan truncation and extra memory/review HTTP
surfaces. Equality-only Store filtering and live offset pagination are deliberate
bounded contracts; runtime semantic retrieval and internal browse tools retain
their richer existing interfaces.
