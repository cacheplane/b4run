# Cooperative Stop on unmodified LangChain

Written 2026-11-08. The user authorized implementation, a PR, and merge when
green after accepting cooperative Stop and reviewing the Managed Deep Agents
research. This document makes that implementation contract concrete. It does
not activate the unfinished coordinated Agent Protocol migration.

## Scope and constraints

- Implement on current main in `feat/cooperative-stop-20261108`, based on
  `0cd99fed50e325ef5b84b91adceca562cdffd09a`.
- Preserve the original root worktree and `protocol/runtime-storage`, including
  its uncommitted R8 work. Do not transplant the experimental Core fork.
- Use published, unmodified LangChain/LangGraph. Existing locked LangGraph
  1.4.17 provides `RunControl`, `requestDrain`, and `GraphDrained`.
- Keep the current HTTP endpoint inventory, authentication, grant validation,
  and AG-UI event formats. No new force-stop endpoint or author tool factory.
- This PR changes ordinary Stop and the native AG-UI disconnect cancellation
  policy to cooperative execution. Preserve the existing AP passive-disconnect
  policy. Shutdown, ownership loss, and explicitly supplied hard abort signals
  remain separate. Do not add a new deadline or automatic force-release policy.

## Execution contract

Each accepted execution has distinct hard-abort and soft-stop channels. The
process-local registry remains the one thread-slot owner. Manual Stop marks its
exact execution requested and requests native drain; it does not abort the
active graph's signal or the HTTP source iterator. A stale cancellation claim
must never affect a successor. Requests are idempotent and the first stop reason
is retained. Listener cleanup remains bounded by the actual execution lifetime.

For LangGraph-backed execution, create a fresh native RunControl per invocation,
link it to the soft-stop signal, and supply it as top-level config.control.
An already requested stop prevents first-node dispatch. The current superstep
finishes and persistence settles before later supersteps stop. Do not call
iterator.return or AbortController.abort to implement a soft stop.

The boundary is deliberately a superstep. Parallel work, retries, nested calls,
and operations inside a running node may finish before it returns. Detached
third-party work that the tool does not await is outside this guarantee.
No promise of remote-effect rollback or universal finalizer quiescence is made.

Plain chains and arbitrary workflow/graph functions are an observable invocation
boundary, not automatically a native graph scheduler. They receive the hard
signal and an optional soft-stop signal; graph-backed runnable objects also
receive native control. Opaque invocations may finish as one unit. Preserve
receivers, state, ordinary schema/callback handling, and optional dependency
loading. Do not misrepresent this as per-tool interruption of arbitrary code.

## Outcome and persistence

Stop requested is not the same fact as stopped. A native GraphDrained outcome,
or an explicitly observed cooperative-stop reason, produces the existing
cancelled/interrupted projection only after its owned work and writes settle.
If the final superstep completes naturally, natural success may win. An
independent execution error must not be relabeled cancelled merely because a
Stop request also arrived. Preserve permission parks and original errors.

Propagate a recognized cooperative-stop outcome through adapter, runtime,
middleware, episode recording, AP stream/wait/resume, AG-UI translation, status,
and turn-end stamping. Avoid recording it as a tool failure or successful episode.
Emit at most one terminal event for each observer; a disconnected observer may
close while execution continues. Registry/shared admission/store/sandbox
lifetimes must remain held until actual execution and final persistence finish.
Concurrent use of the same thread must continue to fail while it is draining.

Native drained checkpoints are resumable. A fresh user turn must never execute
pending source actions from that stopped invocation. Under the existing run
exclusion, retire those native future tasks nonexecutingly using the public
updateState(null, END) mechanism where supported. Preserve useful state, history,
and uncertainty; do not manufacture successful results or claim every unmatched
tool call never began. Reuse the existing dangling-tool-history handling where
appropriate, correcting misleading not-executed wording if needed.

An explicit permission resume must retain Command identity and must not be
rewritten into a fresh turn. Do not clear a live permission park, approve a
pending action, or clone/reuse a grant. If a state cannot safely be rebound,
fail before model/tool execution. Guard subsequent fresh turns as well so a
failed retirement cannot silently resume unsafe pending tasks. Do not introduce
a second durable owner, operation ledger, or scheduler for this feature.

Hard abort behavior remains distinguishable from clean cooperative settlement.
An HTTP wait ending is not proof that execution stopped. Preserve existing
ownership retention on abandoned responses and do not advertise forced loss
or arbitrary remote effects as clean unwind.

## Required evidence

Tests use real unmodified LangGraph and controlled model/tool barriers. Prove:

1. Stop does not abort a running tool's signal; its finally/effect and a held
   real checkpoint write finish before the thread is reusable.
2. The next graph superstep does not run; parallel and nested graphs settle
   without a concurrent second invoke or accidental native permission resume.
3. Pre-requested stop runs no first task; repeated/stale claims are safe;
   natural final-step success and independent errors remain truthful.
4. AP stream, wait, and resume plus native AG-UI SSE/protobuf use the same
   outcome and gate. AG-UI disconnect requests soft Stop, retains execution
   resources, and does not publish duplicate terminal events to attachers.
5. Fresh input after drain executes no pending source tool, including Stop
   after a model emitted tool calls and a nested partial execution. Explicit
   permission/client-tool resume remains valid and requires authorization.
6. Hard shutdown still reaches a separate AbortSignal. Opaque chain/workflow
   boundaries and timeout limitations are documented rather than overclaimed.

Run repository validation and required GitHub checks on the final PR head.
Merge only when required checks are green; do not waive failures from the old
protocol branch or unrelated baseline. Publication and coordinated protocol
cutover remain outside this PR.

## Primary research

- [LangGraph graceful shutdown](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance#graceful-shutdown)
- [LangGraph 1.4.17 control source](https://github.com/langchain-ai/langgraphjs/blob/3dd35b6d0c4d7e5d2499ce44d85ecb0c0a34e1fd/libs/langgraph-core/src/pregel/runtime.ts)
- [Release-pinned control tests](https://github.com/langchain-ai/langgraphjs/blob/3dd35b6d0c4d7e5d2499ce44d85ecb0c0a34e1fd/libs/langgraph-core/src/tests/run_control.test.ts)

The earlier private Core-modification prototype is research evidence only. Its
109 passing tests do not qualify this implementation. New integration evidence
must use the public, unmodified dependency graph.
