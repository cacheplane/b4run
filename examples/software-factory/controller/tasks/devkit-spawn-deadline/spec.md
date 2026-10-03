# Clear the deadline when a spawn fails asynchronously

`spawnProcess` in `packages/devkit/src/testing/process.ts` arms a deadline timer
when `timeoutMs` is given. When the child cannot be spawned at all, the `error`
event rejects the close promise, but the timer it armed is left running for the
whole `timeoutMs`, keeping the event loop alive long after the rejection. Repair
it so the timer is cleared on every exit from the race, including the spawn
error.

Reproduce it with the package's own tests (`spawnProcess clears the deadline
when spawning fails asynchronously` fails), then repair only
`packages/devkit/src/testing/process.ts`. Do not change tests, configuration,
templates, or any other file.

A1: a spawn that fails asynchronously rejects with the spawn error and leaves no
deadline timer running.
A2: the existing behaviour of `spawnProcess` is unchanged: a process that exits
within its deadline resolves with its exit code and output, and a process that
exceeds its deadline is terminated with `timedOut` set.

Non-goal: no change to the exported types and no new options.
