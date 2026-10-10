/**
 * The RAG take's storyboard: the compliance app's code beside the same app
 * running in the real Workbench, in the navlog take's style (the same director,
 * `../demo/director.mjs`). Paths are relative to the generated app's root,
 * which is also their place under `app/`. Each code pane's `focal` pattern must
 * match exactly one line of its file. For an app beat the capture performs the
 * beat's action, then holds for `holdMs`.
 */

const freezeBeat = (beat) =>
  Object.freeze({
    ...beat,
    ...(beat.panes !== undefined
      ? { panes: Object.freeze(beat.panes.map((pane) => Object.freeze({ ...pane }))) }
      : {}),
  })

export const RAG_STORYBOARD = Object.freeze(
  [
    {
      id: "title",
      kind: "title",
      headline: "compliance",
      subtitle: "Grounded answers, built with B4.run",
      holdMs: 2000,
    },
    {
      id: "agent",
      kind: "code",
      headline: "One file is the agent.",
      panes: [
        {
          path: "server/src/app/compliance/index.ts",
          focal: /^\s+tools: \{ deny: \["runBash", "writeFile", "editFile"\] \},$/u,
        },
      ],
      holdMs: 3400,
    },
    {
      id: "ask",
      kind: "app",
      headline: "Ask the question.",
      focus: "rest",
      action: "ask",
      holdMs: 3800,
    },
    {
      id: "search",
      kind: "code",
      headline: "Search is a plain function.",
      panes: [
        {
          path: "server/src/tools/searchPlans.ts",
          focal: /^\s+sources: \(hits\) => hits\.map\(citation\),$/u,
        },
      ],
      holdMs: 4000,
    },
    {
      id: "cite",
      kind: "app",
      headline: "Every claim has a source.",
      focus: "steps",
      action: "cite",
      holdMs: 4200,
    },
    {
      id: "checker",
      kind: "code",
      headline: "A checker does the review.",
      panes: [
        {
          path: "server/src/app/compliance/subagents/checker/index.ts",
          focal: /^\s+allow: \["searchPlans", "readSection"\],$/u,
        },
      ],
      holdMs: 4000,
    },
    {
      id: "checklist",
      kind: "app",
      headline: "Met, partial, missing.",
      focus: "answer",
      action: "checklist",
      holdMs: 5000,
    },
    { id: "close", kind: "close", headline: "Answers you can check.", holdMs: 2600 },
  ].map(freezeBeat),
)

export const RAG_APP_ACTIONS = Object.freeze(["ask", "cite", "checklist"])

/**
 * Camera presets over the Workbench (1440x810, scaled to the frame). The
 * overlay's desktop layout: the sidenav (x 1–15%), the chat (15–61%) and the
 * source reader (62–99%). `origin` is the point the zoom holds still.
 */
export const RAG_APP_FOCUS = Object.freeze({
  rest: Object.freeze({ scale: 1, origin: "50% 50%" }),
  // The chat column, its middle: the plan's to-dos, the steps and their chips.
  todos: Object.freeze({ scale: 1.5, origin: "40% 45%" }),
  steps: Object.freeze({ scale: 1.5, origin: "40% 50%" }),
  // The chat's lower half: the answer's checklist.
  answer: Object.freeze({ scale: 1.4, origin: "36% 75%" }),
  // The chat and the reader together, once a chip opened its source.
  reader: Object.freeze({ scale: 1.3, origin: "100% 12%" }),
})

/** The beat the poster is taken from: the checklist with its source open. */
export const RAG_POSTER_BEAT = "checklist"
