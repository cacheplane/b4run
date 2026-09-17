# Software factory rung 0: live demonstration

Status: procedure written; the results section is filled in by the one recorded live run.
Spec: ../specs/2026-09-16-software-factory-rung0-design.md, "Live demonstration" and
success criterion 2.

This is evidence that the controller seam works with the real code-fixer and a real model,
including one factory restart while the work order waited for approval. It is not a benchmark
and it says nothing about repair quality beyond one fixture.

## Procedure

1. `nvm use 24`, `pnpm install`, `pnpm turbo run build --filter=@b4-example/code-fixer-server...`.
2. `pnpm --filter @b4-example/code-fixer-server sandbox:prepare` (builds `b4-code-fixer:fixture-v1`;
   the plain script is `sandbox:prepare`, run through pnpm's workspace filter from the repo root).
3. Start the worker with a real key: `cd examples/code-fixer/server && OPENAI_API_KEY=... pnpm dev --port 4100`.
4. In `examples/software-factory/server`, with `FACTORY_WORKER_URL=http://127.0.0.1:4100`,
   `FACTORY_WORKER_OUTBOX=<code-fixer>/.b4/code-fixer/review-outbox`, `FACTORY_STATE_DIR=$PWD/.factory`:
   `pnpm factory create --task cli-flags`, then `pnpm factory dispatch <id> --wait`.
5. Record the state. If it is `awaiting_approval`, do NOT approve yet.
6. Restart test: run `pnpm factory show <id>` (each CLI invocation is a fresh factory process,
   so this is a restart) and record that the state is still `awaiting_approval` with the same
   revision and interrupt id, and that the event log gained a `reconciled` event with
   `gate_still_pending`.
7. `pnpm factory approve <id> --revision <n> --digest <d>`. Record the outcome.
8. `pnpm factory events <id> > events.json`; copy the fields below from it and from the outbox.
9. Retry nothing. If the run fails or blocks, record that outcome; it is still evidence.

## Results

| Field | Value |
|---|---|
| Date | |
| Model (B4_CODE_FIXER_MODEL) | |
| Work order id | |
| Worker thread id (`thread_created` event) | |
| Candidate digest (`candidate_observed`) | |
| Interrupt id (`candidate_interrupt`) | |
| State after restart (`show`) and `reconciled` event present | |
| Final state | |
| Receipt path (`delivery_observed`) | |
| Receipt filename equals digest | yes / no |
| Wall-clock from dispatch to awaiting_approval | |
| Wall-clock from approve to exported | |
| Anything unexpected in the event log | |
