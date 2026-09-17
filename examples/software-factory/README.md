# Software factory (rung 0)

A work-order controller that drives the [code-fixer](../code-fixer) example over the
Agent Protocol. It is the first, deliberately narrow rung of the
[software factory program](../../docs/superpowers/specs/2026-09-16-software-factory-rfc.md);
the rung 0 design is in
[its spec](../../docs/superpowers/specs/2026-09-16-software-factory-rung0-design.md).

## What it proves

- The factory owns the lifecycle. A closed state machine, an append-only event journal, and a
  two-phase command log keyed by operation key live in `registry.sqlite`. Retrying a command
  returns the recorded outcome instead of repeating the effect.
- Workers are ordinary B4 `agent` routes reached over the Agent Protocol on loopback. The
  child thread id is committed before the run starts; cancel is propagated explicitly.
- Approval is a factory command against an exact candidate digest and the exact worker prompt
  recorded for it. The receipt the worker writes must carry the approved digest.
- Restart reconciliation never re-dispatches. It inspects the worker and the outbox and
  records what it concluded.

## What it does not do

No authentication (loopback only; do not expose it). No repair loop, no token budgets, one
task (`cli-flags`), no UI, and the code-fixer example is used exactly as shipped. Rung 1 moves
verification into the controller and replaces the shared-host outbox read.

**Deferred: an offline test lane against the real code-fixer.** The testing package's
`aimock` fixtures are static, while the worker's export call carries a candidate that only
exists after `prepareReview` runs in the same turn, so that turn cannot be replayed offline.
All invariants run against a scripted fake Agent Protocol worker (`pnpm test`); the real
worker is exercised by the recorded live demonstration in
`docs/superpowers/runbooks/software-factory-rung0-live.md`.

## Run it

Terminal 1, the worker (needs Docker and the fixture image):

    cd examples/code-fixer/server && pnpm sandbox:prepare && pnpm dev --port 4100

Terminal 2, the factory:

    cd examples/software-factory/server
    export FACTORY_WORKER_URL=http://127.0.0.1:4100
    export FACTORY_WORKER_OUTBOX=$PWD/../../code-fixer/server/.b4/code-fixer/review-outbox
    export FACTORY_STATE_DIR=$PWD/.factory
    pnpm factory create --task cli-flags
    pnpm factory dispatch <id> --wait
    pnpm factory approve <id> --revision <n> --digest <sha256>
    pnpm factory events <id>

`dispatch --wait` returns when the worker has parked on its approval prompt with a verified
candidate. Approve with the revision and digest it printed, or `deny`. `pnpm factory serve`
exposes the same commands as JSON on 127.0.0.1.

## Tests

    pnpm test        # every invariant, against the scripted fake worker
