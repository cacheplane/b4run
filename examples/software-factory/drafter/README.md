# Software factory drafter

The drafter app of the [software factory](../README.md): one `intake` agent route with the four
built-in workspace tools and nothing else, run as its own process on the pinned `node:24-slim`
base image (`src/drafter-image.ts`) with the network denied and permissions non-interactive.
It is driven by the controller, never by hand: for each work order the controller writes a
manifest `<FACTORY_DRAFTER_MANIFEST_DIR>/<workOrderId>.json` holding a wide read-only capture
of the repository at the work order's pin, creates a thread with `{ factoryWorkOrderId }`, and
sends the issue and the prepared targets in the user message; the thread's resolver loads that
manifest and serves that capture under `repo/`, and the route writes exactly four files under
`draft/`, which the controller then reads and proves before anyone approves anything.

It reads `FACTORY_DRAFTER_MANIFEST_DIR` (required at boot: the manifest directory, which may
be empty; a thread whose manifest is missing is refused by name), `FACTORY_DRAFTER_IMAGE`
(default: the pinned digest in `src/drafter-image.ts`) and `FACTORY_DRAFTER_MODEL` (default
`gpt-5-mini`). `B4_PERMISSIONS_MODE` in the drafter process's environment overrides
`permissions.mode`, so do not set it for the drafter: `non-interactive` is what keeps a turn
from waiting on a person nobody has posted. `pnpm check` and `pnpm build` default the directory to `.factory/manifests`
so the repository's unfiltered graph passes; `pnpm dev` does not, so a running drafter always
has the directory the controller was told about. `pnpm test` is the always-on lane (the
config and the route's static shape); `pnpm test:sandbox` needs Docker and the base image
pulled by digest, serves this app from a private copy and proves the resolver: two threads
for two work orders each admitted with their own capture, a third with no manifest refused
by name. The whole intake for real, through the controller, is the controller's
`drafter-end-to-end.integration.test.ts`.
