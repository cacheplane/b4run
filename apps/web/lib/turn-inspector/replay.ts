import type { Capture, Change, ReplayState } from "./capture-types"

function put<T extends { id: string }>(rows: T[], value: T): T[] {
  return rows.some((row) => row.id === value.id)
    ? rows.map((row) => (row.id === value.id ? value : row))
    : [...rows, value]
}

/** Pure prefix reduction. A completed snapshot replaces streamed content. */
export function applyChange(state: ReplayState, change: Change): ReplayState {
  switch (change.kind) {
    case "turn":
      return { ...state, turns: put(state.turns, change.turn) }
    case "item":
      return { ...state, items: put(state.items, change.item) }
    case "request":
      return { ...state, requests: put(state.requests, change.request) }
    case "notice":
      return {
        ...state,
        notices: [...state.notices, { code: change.code, text: change.text }],
      }
    case "delta":
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === change.itemId
            ? {
                ...item,
                content: {
                  available: true,
                  value: `${item.content.available ? item.content.value : ""}${change.text}`,
                },
              }
            : item,
        ),
      }
  }
}

export function stateAt(capture: Capture, index: number): ReplayState {
  if (!Number.isInteger(index) || index < -1 || index >= capture.events.length)
    throw new Error("Invalid replay index")
  let state = capture.initial
  for (let i = 0; i <= index; i++) {
    for (const change of capture.events[i]!.changes) state = applyChange(state, change)
  }
  return state
}
