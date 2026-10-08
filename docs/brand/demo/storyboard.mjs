/**
 * The take-2 storyboard (spec §3): the navlog demo alternates the code behind
 * each feature with the feature running in the real Workbench.
 *
 * Paths are relative to the generated app's root, which is also their place
 * under `packages/devkit/templates/app-navlog`. Each code pane's `focal`
 * pattern must match exactly one line of its file; the director marks that
 * line, and the part of it the pattern matches is what the camera keeps in
 * view. `holdMs` is the stillness after the beat's motion. For an app beat the
 * director does not wait it: the capture performs the beat's real action
 * first, then holds.
 */

const freezeBeat = (beat) =>
  Object.freeze({
    ...beat,
    ...(beat.panes !== undefined
      ? { panes: Object.freeze(beat.panes.map((pane) => Object.freeze({ ...pane }))) }
      : {}),
  })

const ROUTE = "server/src/app/navlog/index.ts"

export const STORYBOARD = Object.freeze(
  [
    {
      id: "title",
      kind: "title",
      headline: "navlog",
      subtitle: "A VFR flight planner, built with B4.run",
      holdMs: 1600,
    },
    {
      id: "agent",
      kind: "code",
      headline: "One file is the agent.",
      panes: [{ path: ROUTE, focal: /tools: \{ deny: \["runBash"\], approve: \[.*\] \},$/u }],
      holdMs: 1500,
    },
    {
      id: "ask",
      kind: "app",
      headline: "Ask for a flight.",
      focus: "todos",
      action: "send-plan",
      holdMs: 2000,
    },
    {
      id: "subagents",
      kind: "code",
      headline: "Subagents brief the weather.",
      panes: [
        {
          path: "server/src/app/navlog/subagents/weather/index.ts",
          focal: /allow: \["getMetar", "getTaf", "getWindsAloft", "getAdvisories"\],/u,
        },
        { path: "server/src/tools/getMetar.ts", focal: /flightCategory: record\.fltCat \?\? "UNKNOWN",/u },
      ],
      holdMs: 3000,
    },
    {
      id: "weather",
      kind: "app",
      headline: "Live weather, judged.",
      focus: "weather",
      action: "weather",
      holdMs: 2500,
    },
    {
      id: "tools",
      kind: "code",
      headline: "Tools do the math.",
      panes: [
        { path: "server/src/tools/computeNavlog.ts", focal: /^\s+computeNavlog\(input\)$/u },
        { path: "server/src/lib/navlog.ts", focal: /const tri = solveWindTriangle\(\{/u },
      ],
      holdMs: 3000,
    },
    {
      id: "navlog",
      kind: "app",
      headline: "A real navlog.",
      focus: "map",
      action: "navlog",
      holdMs: 2500,
    },
    {
      id: "gate",
      kind: "code",
      headline: "Filing needs a yes.",
      panes: [{ path: ROUTE, focal: /approve: \[\{ tool: "fileFlightPlan", allowAlways: false \}\]/u }],
      holdMs: 2000,
    },
    {
      id: "file",
      kind: "app",
      headline: "Approve once.",
      focus: "approval",
      action: "file-approve",
      holdMs: 2000,
    },
    {
      id: "memory",
      kind: "code",
      headline: "It remembers you.",
      panes: [{ path: "server/src/app/navlog/memory.ts", focal: /scope: \["workspace", "route"\],/u }],
      holdMs: 2000,
    },
    {
      id: "reload",
      kind: "app",
      headline: "Reload. Still there.",
      focus: "memory",
      action: "memory-reload",
      holdMs: 2000,
    },
    { id: "close", kind: "close", headline: "Ridiculous speed. Readable code.", holdMs: 1800 },
  ].map(freezeBeat),
)

/** The real interaction the capture performs for each app beat, by action id. */
export const APP_ACTIONS = Object.freeze([
  "send-plan",
  "weather",
  "navlog",
  "file-approve",
  "memory-reload",
])

/**
 * Camera presets for app beats, over the Workbench as the frame shows it. The
 * Workbench lays out at a fixed 1440x810 and the frame scales it to fit
 * exactly, so a percentage of the camera is the same percentage of the
 * Workbench. Desktop layout (`WorkbenchLayout.tsx`, `theme.css`): the chat dock
 * floats left (16px gutter, 380px wide: 1–28%), with the memory panel under
 * its header, the run's activity (the plan's to-dos) in the middle, and an
 * approval card above the composer at the bottom; the weather strip sits
 * top-right (29–99%, 2–10%, right-aligned) with the verdict pill; the navlog
 * sheet runs along the bottom right of the dock (29–99%, up to 46vh tall); the
 * map fills the rest. The origin is the point the zoom holds still. These are
 * starting values; the capture may refine them after a real run.
 */
export const APP_FOCUS = Object.freeze({
  rest: Object.freeze({ scale: 1, origin: "50% 50%" }),
  todos: Object.freeze({ scale: 1.55, origin: "2% 42%" }),
  weather: Object.freeze({ scale: 1.45, origin: "98% 3%" }),
  map: Object.freeze({ scale: 1.3, origin: "66% 32%" }),
  sheet: Object.freeze({ scale: 1.45, origin: "70% 94%" }),
  approval: Object.freeze({ scale: 1.55, origin: "2% 92%" }),
  memory: Object.freeze({ scale: 1.55, origin: "2% 12%" }),
})

/** Every file the storyboard shows, once each, in first-use order. */
export function storyboardPaths(storyboard = STORYBOARD) {
  return [
    ...new Set(storyboard.flatMap((beat) => (beat.panes ?? []).map((pane) => pane.path))),
  ]
}
