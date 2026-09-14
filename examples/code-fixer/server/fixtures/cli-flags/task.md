# Repair CLI flag forwarding

The documented command `node --import tsx src/cli.ts memory consolidate --dry-run`
fails before the handler runs. Reproduce the failure with `npm test`, repair
the CLI registration, and verify it. Preserve memory-level `--cwd`, value-taking
`prune --cap`, and rejection of invalid arguments. Change only `src/cli.ts`.
Do not change tests, dependency versions, configuration, or the handler.
