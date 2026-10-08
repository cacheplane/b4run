import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { APPROVAL_FIXTURES, TURN_FIXTURES } from "../fixtures/activity-fixtures.ts"
import {
  CONTRACT_SNAPSHOT_PATH,
  type ContractSnapshot,
  expandAll,
  serializeContract,
} from "../fixtures/contract-serializer.ts"
import { button, click, mountApproval, mountTurn, settle } from "./render.js"

/**
 * The Angular half of the kit-parity check: every shared fixture, serialized
 * through the DOM contract, must equal the snapshot the React kit writes
 * (`B4_UPDATE_CONTRACT=1` in `@b4run/ag-ui`). Never written from here: when
 * this fails and React's passes, the Angular kit is the one that moved.
 */
const committed = JSON.parse(readFileSync(CONTRACT_SNAPSHOT_PATH, "utf8")) as ContractSnapshot

describe("Angular kit ↔ DOM contract snapshot", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("covers every fixture the snapshot holds", () => {
    expect(Object.keys(TURN_FIXTURES).sort()).toEqual(Object.keys(committed.turns).sort())
    expect(Object.keys(APPROVAL_FIXTURES).sort()).toEqual(Object.keys(committed.approvals).sort())
  })

  for (const [name, fixture] of Object.entries(TURN_FIXTURES)) {
    test(`turn: ${name}`, async () => {
      const mounted = mountTurn(fixture)
      const root = mounted.nativeElement as HTMLElement
      const initial = serializeContract(root)
      await expandAll(root, (target) => click(mounted, target))
      const expanded = serializeContract(root)
      expect({ initial, expanded }).toEqual(committed.turns[name])
    })
  }

  for (const [name, fixture] of Object.entries(APPROVAL_FIXTURES)) {
    test(`approval: ${name}`, async () => {
      const outcome = fixture.decide?.outcome
      const mounted = mountApproval(fixture, () =>
        outcome === "reject" ? Promise.reject(new Error("network down")) : new Promise(() => {}),
      )
      const root = mounted.nativeElement as HTMLElement
      if (fixture.decide) {
        const label = { once: "Allow once", always: "Always allow", deny: "Deny" }[
          fixture.decide.choice
        ]
        click(mounted, button(root, label))
        await settle(mounted)
      }
      expect(serializeContract(root)).toEqual(committed.approvals[name])
    })
  }
})
