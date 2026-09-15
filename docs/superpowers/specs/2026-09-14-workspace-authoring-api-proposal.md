# Workspace authoring API proposal

Date: 2026-09-14
Status: proposed authoring surface; not implemented

Builds on the approved [provider lifecycle boundary](2026-09-14-provider-owned-workspace-lifecycle-design.md).
This proposal settles how an application declares initial content and consumes
trusted workspace provenance. Provider operation records and concrete storage
implementation follow these author-facing requirements; this is not yet an
implementation-ready storage specification.

## Recommended configuration

Keep the existing sandbox configuration and workspace tools. Add a declarative
workspace source to the sandbox block rather than a new route kind or runner.
For code-fixer, a small fixture helper assembles the descriptor from its trusted
catalog. It does not open Docker, seed files, or keep lifecycle state.

```ts
// Proposed API, not currently exported.
import { config } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { fixtureWorkspace } from "./src/fixtures/workspace.js"

export default config({
  appDir: "src/app",
  sandbox: {
    provider: dockerSandbox({
      scope: "code-fixer-local",
      image: "b4-code-fixer:local",
    }),
    workspace: fixtureWorkspace("cli-flags"),
    network: { mode: "deny" },
  },
})
```

This excerpt focuses on workspace declaration. The complete example retains its
existing resource restrictions, permission rules, model configuration, and
approval-gated tool. Scope must be installation-specific outside the local
example. Mutable image tags are resolved to immutable identities before creation
intent is persisted.

## Source descriptor

Recommend a portable source bundle captured from declared application files.
An image-only initial directory would reduce upload work but tie fixture changes
to image builds. An arbitrary initializer callback would reintroduce the recovery
problem. The portable bundle keeps source and execution environment independent.

The fixture helper returns a WorkspaceDefinition containing:

- `source`: a declarative directory descriptor with an explicit file inventory
  and additional named text/file entries, such as TASK.md and .gitignore.
- `environmentLinks`: explicitly declared workspace paths pointing to immutable
  directories supplied by the pinned environment. Code-fixer needs node_modules
  to refer to the dependencies already installed in /opt/fixtures/<fixture>.
- `baseline`: optionally request an initial Git commit from the captured source.
  This is declarative setup with a recorded result, not an arbitrary shell hook.

These are proposed property names, not existing exports. A full helper should be
roughly an inventory mapping and two environment/baseline declarations. It must
contain no runtime-specific handles, global maps, process identity, or cleanup.

Ordinary sources contain regular files with exact bytes and executable flags.
Reject traversal, duplicates, ancestor conflicts, unlisted files in a strict
inventory, special files, and filesystem symlinks. The environmentLinks field is
the only permitted link mechanism in this first slice: it is trusted config,
included in creation identity, validated against the immutable environment, and
must not overlap source entries. Its target must remain read-only during agent
execution. Unsupported providers reject the definition before creation.

The optional Git baseline uses a fixed identity, timestamp, and explicit source
inventory; disable ambient Git configuration and hooks. Record the resulting
commit in trusted provenance outside the workspace. Mutable .git files inside
the workspace are never authoritative for verification. A provider can implement
the result through its own preparation mechanism; B4 does not require it to run
a particular shell command or use a Docker preparer.

## Capture and build behavior

Source descriptors resolve paths relative to appRoot, not process.cwd(). The
helper returns descriptors without eagerly reading files while config loads.

In development, capture the exact declared bytes before a new workspace's intent
is written. Save a canonical manifest, bytes, and digest into runtime-owned
content-addressed storage, outside agent-visible files. Repeated creation attempts
use that captured bundle, never reread a changing application directory. Failure
to capture or durably retain the bundle prevents provider creation.

For built Node applications, b4 build materializes declared bundles in its build
artifacts and records their digests. Startup verifies and imports the bundle into
durable runtime storage before use. A build must not silently rely on a developer
checkout remaining available. Existing workspaces continue using their recorded
source after deployment changes; new workspaces use the newly built source.

Keep bundles referenced by pending operations or live workspace provenance.
Garbage collection is outside the first implementation; retaining extra bundles
is preferable to deleting recovery inputs prematurely. Whole durable-state loss
is not repaired by reseeding from the current build.

Provider adapters receive immutable content and identity, not host filenames or
arbitrary fetch URLs. They may upload the bundle or reference a provider-side
immutable artifact they have validated. Streaming/binary transport details belong
to the provider contract; no mandatory tar extraction or shell interpolation.

## Tools and trusted context

The model continues to use readFile, listDir, writeFile, and runBash. Preserve the
existing app-root workspace/ activation convention in this slice: the example
keeps its workspace directory, and b4 check rejects a managed-workspace definition
whose required capability is not active. Do not add a second discovery marker.

Propose an optional readonly `ctx.workspace` on authored tool context, present
only for an admitted managed workspace. It supplies:

- Stable workspace identity and initial source digest.
- Immutable environment identity and optional initial Git commit.
- A bound readInitialFile(path) operation for captured source bytes.

Do not expose a raw provider handle, account credentials, reconnect/destroy
operations, caller-selectable thread IDs, or a writable metadata store. The
context binds reads to the admitted workspace and uses the same read permission
policy as the corresponding workspace path. It cannot be used to enumerate
another thread's source. No automatic new model-facing tool is registered.

The code-fixer can compare current files read through ctx.fs with initial bytes
from ctx.workspace, without a process-global baseline map. Its verifier still
owns fixture correctness and restrictions. Independent verifier inputs and hidden
tests must never enter the captured agent source or sandbox image.

## Fixture selection and scope

First delivery uses cli-flags as the normal server's default. The nullable fixture
remains available through an explicit alternative configuration for its eval case.
The config accepts either descriptor; this proposal does not invent an agent
inputSchema API, a model-selected provider, or request-time source selectors.

Changing the configured default affects new workspaces only. Existing threads
retain their captured source, baseline, and provider reference. Concurrent threads
have independent writable workspaces even when they share a source bundle.

Review/export approval binding remains a separate application correction: source
provenance does not itself prove a candidate passed independent verification or
was the candidate the human approved.

## Required verification and next decision

Verify descriptor canonicalization, exact binary/UTF-8 bytes, rejected paths and
links, capture failure before provisioning, immutable environment links, Git
baseline determinism, permission-bound initial reads, no cross-thread access,
rollout changes, and built-runtime execution after removing original source
directories. Validate both fixture definitions without model calls.

Combine those cases with the approved lifecycle fault tests. Do not claim the
API works until normal dev, built Node, restart, approval/resume, and both fixture
evaluations exercise the resulting implementation.

Review the source descriptor and trusted tool context as one authoring surface.
Once accepted, finish concrete provider/store signatures and create the bounded
implementation plan. No production code or PR is part of this proposal.
