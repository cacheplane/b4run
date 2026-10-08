# B4.run product-loop media transcript

The product loop is silent. Its headlines are repeated here so the same proof
is available without motion. The footage begins inside an existing generated
navlog workspace; it does not show the scaffold command running.

## Product loop

### Write the agent.

The headline docks above a square-cornered frame that shows two real files from the
generated workspace: the route `server/src/app/navlog/index.ts`, with its
`export default agent({` descriptor, and the shared tool
`server/src/tools/computeNavlog.ts`. The camera eases to the route's
`description` line, marked with a Relay bar.

### Test it offline.

The frame shows the generated workspace's real `npm test` output, narrowly
normalized: ANSI codes are removed, the temporary root reads `<workspace>`, and
durations read `<time>`. The navlog server tests pass without a provider key,
and the camera eases to their passing summary.

### Reload. Still there.

The frame holds the actual generated B4.run Workbench. The prompt is already
in the composer when the beat begins; the capture filled it before recording.
It sends “Plan a VFR flight from KSTP to KRST at 4500 feet, departing
1400Z.” to `/navlog#agent`. The visible activity names the `computeNavlog` call, and the answer reads
“KSTP and KRST are VFR. 66 nm, 33 minutes, 5.5 gal burned, reserve about 6
hours. [poh/cruise-performance.md, Figure 5-7]”. The browser frame then
reloads, the same thread is reopened from the rail, and the prompt, the tool
call, the answer, and the navlog sheet reappear from the server checkpoint.
This shows browser-reload restoration with the B4.run server still running,
not restoration after a server restart.

### Close

A hairline carrying the Relay dot sweeps across to the closing card: the
b4.run wordmark, “Ridiculous speed. Readable code.”, and
`npm create b4-app@latest my-agent`. The command is an activation next step;
scaffolding is not part of the footage.
