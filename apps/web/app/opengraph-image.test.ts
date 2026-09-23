import { describe, expect, it } from "vitest"
import * as siteImage from "./opengraph-image"

describe("site Open Graph image", () => {
  it("runs on Node so the build prerenders it instead of an edge function per request", () => {
    expect("runtime" in siteImage).toBe(false)
  })

  it("renders a 1200 by 630 PNG from local assets", async () => {
    const response = siteImage.default()
    const bytes = new Uint8Array(await response.arrayBuffer())
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(response.headers.get("content-type")).toMatch(/^image\/png(?:;|$)/)
    expect(view.getUint32(16)).toBe(siteImage.size.width)
    expect(view.getUint32(20)).toBe(siteImage.size.height)
  })
})
