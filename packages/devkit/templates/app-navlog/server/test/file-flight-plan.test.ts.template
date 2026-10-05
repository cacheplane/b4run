import type { B4ToolContext } from "@b4run/sdk"
import { describe, expect, it, vi } from "vitest"
import fileFlightPlan from "../src/tools/fileFlightPlan.ts"

describe("fileFlightPlan", () => {
  it("writes the FPL message to the workspace and says it was recorded, not transmitted", async () => {
    const writeFile = vi.fn(async () => ({ bytesWritten: 1 }))
    const ctx = {
      signal: new AbortController().signal,
      fs: { writeFile },
    } as unknown as B4ToolContext
    const out = await fileFlightPlan(
      {
        flightPlan: {
          item7: "N738ZU",
          item8: "VG",
          item9: "C172/L",
          item10: "SG/C",
          item13: "KSTP1400",
          item15: "N0110VFR DCT",
          item16: "KRST0048",
          item18: "DOF/261005",
          item19: "E/0640 P/2",
        },
      },
      ctx,
    )
    expect(writeFile).toHaveBeenCalledWith(
      "flight-plans/261005-KSTP-KRST.txt",
      "(FPL-N738ZU-VG\n-C172/L-SG/C\n-KSTP1400\n-N0110VFR DCT\n-KRST0048\n-DOF/261005\n-E/0640 P/2)\n",
    )
    expect(out).toEqual({
      status: "recorded",
      path: "flight-plans/261005-KSTP-KRST.txt",
      transmitted: false,
    })
  })
  it("refuses a location id that is not four letters or digits, before writing anything", async () => {
    const writeFile = vi.fn(async () => ({ bytesWritten: 1 }))
    const ctx = {
      signal: new AbortController().signal,
      fs: { writeFile },
    } as unknown as B4ToolContext
    await expect(
      fileFlightPlan(
        {
          flightPlan: {
            item7: "N738ZU",
            item8: "VG",
            item9: "C172/L",
            item10: "SG/C",
            item13: "../x1400",
            item15: "N0110VFR DCT",
            item16: "KRST0048",
            item18: "DOF/261005",
            item19: "E/0640 P/2",
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/item 13 must start with a four-character location id/)
    expect(writeFile).not.toHaveBeenCalled()
  })
})
