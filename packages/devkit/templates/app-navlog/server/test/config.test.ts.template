import { describe, expect, it } from "vitest"
import config from "../b4.config.ts"

describe("b4.config", () => {
  it("never offloads the results the Workbench reads", () => {
    expect(config.toolOutput?.noOffloadTools).toEqual(
      expect.arrayContaining(["computeNavlog", "findRouteStations"]),
    )
  })
})
