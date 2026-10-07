// @vitest-environment jsdom
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ApprovalCard } from "../../src/react/activity/ApprovalCard.js"
import { TurnActivity } from "../../src/react/activity/TurnActivity.js"
import { APPROVAL_FIXTURES, TURN_FIXTURES } from "../fixtures/activity-fixtures.ts"
import {
  CONTRACT_SNAPSHOT_PATH,
  type ContractSnapshot,
  expandAll,
  serializeContract,
} from "../fixtures/contract-serializer.ts"

/**
 * The React half of the kit-parity check: every shared fixture, serialized
 * through the DOM contract, must equal the committed snapshot the Angular kit
 * is also held to. `B4_UPDATE_CONTRACT=1` rewrites the snapshot from React —
 * review the diff, then the Angular parity test must match it.
 */
const SNAPSHOT_PATH = CONTRACT_SNAPSHOT_PATH
const update = process.env.B4_UPDATE_CONTRACT === "1"
const committed: ContractSnapshot | undefined = existsSync(SNAPSHOT_PATH)
  ? (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as ContractSnapshot)
  : undefined
const fresh: {
  turns: Record<string, { initial: string; expanded: string }>
  approvals: Record<string, string>
} = { turns: {}, approvals: {} }

describe("React kit ↔ DOM contract snapshot", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
  afterAll(() => {
    if (update) writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(fresh, null, 2)}\n`)
  })

  test("the snapshot exists (B4_UPDATE_CONTRACT=1 writes it)", () => {
    expect(update || committed !== undefined).toBe(true)
  })

  for (const [name, fixture] of Object.entries(TURN_FIXTURES)) {
    test(`turn: ${name}`, async () => {
      const { container } = render(
        <TurnActivity
          turn={fixture.turn}
          now={() => fixture.now}
          labels={fixture.labels}
          nested={fixture.nested}
        />,
      )
      const initial = serializeContract(container)
      await expandAll(container, (button) => {
        fireEvent.click(button)
      })
      const expanded = serializeContract(container)
      fresh.turns[name] = { initial, expanded }
      if (!update) expect({ initial, expanded }).toEqual(committed?.turns[name])
    })
  }

  for (const [name, fixture] of Object.entries(APPROVAL_FIXTURES)) {
    test(`approval: ${name}`, async () => {
      const outcome = fixture.decide?.outcome
      const { container } = render(
        <ApprovalCard
          approval={fixture.approval}
          agent={fixture.agent}
          label={fixture.label}
          onDecide={() =>
            outcome === "reject"
              ? Promise.reject(new Error("network down"))
              : new Promise<void>(() => {})
          }
        />,
      )
      if (fixture.decide) {
        const label = { once: "Allow once", always: "Always allow", deny: "Deny" }[
          fixture.decide.choice
        ]
        const button = Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent === label,
        )
        await act(async () => {
          button?.click()
        })
      }
      const contract = serializeContract(container)
      fresh.approvals[name] = contract
      if (!update) expect(contract).toEqual(committed?.approvals[name])
    })
  }
})
