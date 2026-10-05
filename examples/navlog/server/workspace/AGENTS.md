# Navlog workspace memory

B4.run injects this file into the agent's system prompt every turn. Use it for
durable flight-planning conventions; the agent updates it with
`writeFile({ path: "AGENTS.md", content: "..." })` when it learns something
worth keeping across sessions.

## House style

- Every performance number comes from a POH table the performance subagent
  read; cite it as the figure, e.g. `[poh/cruise-performance.md, Figure 5-7]`.
- Weather comes from the live tools, never from memory. Quote the raw METAR
  and TAF the brief is based on.
- Never do navigation arithmetic yourself. `computeNavlog` owns distance,
  course, wind correction, groundspeed, time and fuel.
- Present the navlog and the brief first. File a flight plan only when the
  pilot asks, and expect the human to approve it.
- Save the navlog as `reports/<departure>-<destination>.md` in the workspace.
