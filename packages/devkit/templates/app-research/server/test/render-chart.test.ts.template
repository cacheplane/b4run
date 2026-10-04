import { describe, expect, it } from "vitest"
import renderChart from "../src/tools/renderChart.js"

const ctx = {} as never // the tool reads no context

function svgOf(part: unknown): string {
  return Buffer.from((part as { source: { value: string } }).source.value, "base64").toString(
    "utf8",
  )
}

describe("renderChart", () => {
  it("returns a text summary and an inline SVG image part", async () => {
    const parts = await renderChart(
      {
        title: "Mentions",
        series: [
          { label: "A", value: 3 },
          { label: "B", value: 1 },
        ],
      },
      ctx,
    )
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: "text", text: 'Chart "Mentions": A 3, B 1.' })
    expect(parts[1]).toMatchObject({
      type: "image",
      source: { type: "data", mimeType: "image/svg+xml" },
    })
    const svg = svgOf(parts[1])
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).toContain("Mentions")
    expect(svg).toContain(">A<")
  })

  it("rejects an empty series and more than 12 bars", async () => {
    await expect(renderChart({ title: "x", series: [] }, ctx)).rejects.toThrow(/series/)
    await expect(
      renderChart(
        {
          title: "x",
          series: Array.from({ length: 13 }, (_, i) => ({ label: `${i}`, value: i })),
        },
        ctx,
      ),
    ).rejects.toThrow(/12/)
  })

  it("rejects non-finite values", async () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        renderChart({ title: "x", series: [{ label: "a", value }] }, ctx),
      ).rejects.toThrow(/finite/)
    }
  })

  it("caps the drawn title and labels at 40 characters", async () => {
    const long = "L".repeat(60)
    const [, image] = await renderChart(
      { title: "T".repeat(60), series: [{ label: long, value: 1 }] },
      ctx,
    )
    const svg = svgOf(image)
    expect(svg).toContain(`>${"L".repeat(40)}<`)
    expect(svg).not.toContain("L".repeat(41))
    expect(svg).toContain(`>${"T".repeat(40)}<`)
    expect(svg).not.toContain("T".repeat(41))
  })

  it("escapes labels and titles", async () => {
    const [, image] = await renderChart(
      { title: "<b>&", series: [{ label: "a<b", value: 1 }] },
      ctx,
    )
    const svg = svgOf(image)
    expect(svg).not.toContain("<b>")
    expect(svg).toContain("&lt;b&gt;&amp;")
    expect(svg).toContain(">a&lt;b<")
  })
})
