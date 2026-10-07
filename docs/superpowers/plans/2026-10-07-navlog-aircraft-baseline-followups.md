# navlog aircraft baseline: follow-ups

Draft only. Not filed; ask Brian before running `gh issue create`.

> **agents-md: an app can't turn off the "update AGENTS.md with writeFile" instruction.**
> `packages/core/src/capabilities/built-in/agents-md.ts:7` always tells the model it may
> `writeFile({ path: "AGENTS.md" })`. navlog now refuses that write (a read-only reference
> corpus, PR #972), so the instruction invites a failing tool call. Proposal: an
> `agentsMd: { writable: false }` config, or detect a refusing backend, so the injected header
> drops the write sentence.
