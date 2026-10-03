# Software factory drafter

The drafter app of the [software factory](../README.md): one `intake` agent route with the four
built-in workspace tools and nothing else, run as its own process on the pinned `node:24-slim`
base image (`src/drafter-image.ts`) with the network denied and permissions non-interactive.
It is driven by the controller, never by hand: for each work order the controller captures a
wide read-only capture of the repository at the work order's pin, uploads it over this app's
Agent Protocol port (`PUT /workspace/sources/<digest>`), creates a thread naming that source
with `{ factoryWorkOrderId, factoryDrafter }`, and sends the issue and the prepared targets in
the user message; the thread's resolver checks that the staged workspace is the one the
handoff names and serves that capture under `repo/`, and the route writes exactly four files
under `draft/`, which the controller then reads and proves before anyone approves anything.
Nothing is shared on disk with the controller.

It reads `FACTORY_WORKER_TOKEN` (required at boot: `src/thread-access.ts` admits only the
controller, and admits a create naming a workspace only for a source the controller uploaded),
`FACTORY_DRAFTER_IMAGE` (default: the pinned digest in `src/drafter-image.ts`) and
`FACTORY_DRAFTER_MODEL` (default
`gpt-5-mini`). `B4_PERMISSIONS_MODE` in the drafter process's environment overrides
`permissions.mode`, so do not set it for the drafter: `non-interactive` is what keeps a turn
from waiting on a person nobody has posted. `FACTORY_DRAFTER_MANIFEST_DIR` is retired: the
drafter refuses to boot while it is set. `pnpm test` is the always-on lane (the
config and the route's static shape). The Docker lanes that serve this app live in the
controller's `test:sandbox`, which needs Docker and the base image pulled by digest:
`drafter-resolver.integration.test.ts` serves this app from a private copy and proves the
resolver (two threads for two work orders each admitted with their own capture, a third
created with no staged workspace, or another one than its handoff names, refused by name), and `drafter-end-to-end.integration.test.ts` is the whole
intake for real, through the controller.
