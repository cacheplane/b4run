---
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/sdk": patch
---

A new `b4.config.ts` option, `agentsMd: { writable: false }`, presents `workspace/AGENTS.md` to agent routes as read-only project guidance instead of agent memory. The injected block is headed `# Project guidance`, says the file is maintained by the app's authors, and tells the model not to modify it, in place of the default `# Memory` header's `writeFile` instruction. The over-64 KiB notice uses the same header. The default (`writable: true`, or no `agentsMd`) is unchanged. The option changes only the prompt; enforce it with a `FilesystemMiddleware` over `backends.filesystem` that refuses writes to `AGENTS.md`, and deny or gate `runBash` for routes that can reach the workspace, since a shell command bypasses that middleware.

`b4 check` and route preparation validate the option through one resolver and reject, with the new `B4_E1010` (Invalid agentsMd config), an `agentsMd` that isn't an object (`agentsMd: false` included), an unknown key in it such as `writeable`, and a non-boolean `writable`, so a misspelled or mistyped key inside `agentsMd` is an error rather than silently leaving the file writable. `CapabilityMarkerContext` gains `agentsMd?: { writable: boolean }`, which the agents-md marker reads.
