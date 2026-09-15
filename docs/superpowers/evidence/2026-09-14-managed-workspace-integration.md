# Managed workspace integration qualification

The current implementation replaces the app-owned initialization/recovery wrappers
with declarative source capture, durable B4 associations, and provider-owned
physical lifecycle. Earlier prototype evidence describes its recorded revisions;
it is not evidence for these runtime paths.

## Executed integration evidence

- Both historical fixture Docker replays passed all six evaluation criteria:
  visible tests, independent assertions, allowed source scope, initial failure
  reproduction, post-edit verification, and actual runtime approval interrupt.
  Batch: `batch-7b44fd2e-f7b1-453a-8ae8-ffc3e24c7dda` in the example's ignored
  artifacts directory. These are scripted repairs, not live model results.
- Example approval integration: two tests passed, covering allow-once export and
  denial. The outbox is empty before approval and remains empty after denial;
  successful export contains the exact reviewed candidate.
- Seven additional example Docker integration tests passed, including independent
  verifier assertions, nullable fixture behavior, disposable workspace cleanup,
  and an actual verifier worker SIGKILL followed by parent recovery.
- Managed Docker lifecycle qualification: 20 tests passed (18 unit, two real
  Docker), including source bytes/modes, immutable links/Git baseline, replaced
  compute sessions, stale release, interrupted preparation, lost publication
  acknowledgment, and interrupted deletion.
- Actual HTTP runtime SIGKILL qualification passed: edited Docker bytes and
  operation identity survived process death and restart; thread deletion completed.
- Generated Node manifest startup passed after removing the original source
  directory. A missing required artifact is rejected.
- Runtime/controller regressions passed for thread isolation, boot failure owner
  release, shutdown retry, development recapture for new threads, active operation
  retention/serialization, exact reconnect identity, expiry, interrupted deletion
  reconciliation, and cleanup retaining pending metadata deletion.
- Example unit suite: 48 passed. Sandbox unit suite: 280 passed, 41 gated tests
  skipped in that unit invocation. Full repository validation is recorded below
  when complete.

## Review and boundaries

Spec and code-quality review findings were resolved with regression coverage.
Managed installations currently require one active Node owner on a local
filesystem and stable boot-owned thread/checkpoint stores. Docker is the qualified
managed provider. Existing Kubernetes sandbox support remains available without
managed lifecycle configuration. Remote providers can implement the same lifecycle
contract; none is claimed qualified by this evidence.

No paid model calls were made. A published registry installation cannot be
qualified until the compatible package release exists. Local tarball/package
checks and the runnable workspace example are separate from that release gate.

The obsolete original-wrapper diagnostic test was retired with its removed app
implementation. Its earlier recorded result remains in the prototype evidence;
the replacement acceptance tests exercise the normal runtime and provider APIs.

## Repository validation and PR

Pending final validation completion and PR URL.
