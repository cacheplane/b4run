import type { B4ContentPart, B4ToolContext } from "@b4run/sdk"

const MAX_BARS = 12
const WIDTH = 480
const BAR_HEIGHT = 22
const GAP = 8
const LABEL_WIDTH = 120
const TOP = 40

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function base64(text: string): string {
  let binary = ""
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Render a horizontal bar chart comparing quantities as an inline SVG, given a
 * short title and up to 12 label/value pairs. Returns a one-line text summary
 * the model always sees, plus the chart image, which is shown to the user and
 * reaches the model only where its provider accepts images in tool results.
 */
export default async (
  input: {
    readonly title: string
    readonly series: ReadonlyArray<{ readonly label: string; readonly value: number }>
  },
  _ctx: B4ToolContext,
): Promise<B4ContentPart[]> => {
  if (input.series.length === 0) throw new Error("renderChart needs at least one series entry")
  if (input.series.length > MAX_BARS) throw new Error(`renderChart draws at most ${MAX_BARS} bars`)
  const max = Math.max(...input.series.map((entry) => entry.value), 0) || 1
  const height = TOP + input.series.length * (BAR_HEIGHT + GAP)
  const bars = input.series
    .map((entry, index) => {
      const y = TOP + index * (BAR_HEIGHT + GAP)
      const width = Math.max(0, Math.round(((WIDTH - LABEL_WIDTH - 60) * entry.value) / max))
      return (
        `<text x="0" y="${y + 16}" font-size="13">${escapeXml(entry.label)}</text>` +
        `<rect x="${LABEL_WIDTH}" y="${y}" width="${width}" height="${BAR_HEIGHT}" fill="#4f46e5"/>` +
        `<text x="${LABEL_WIDTH + width + 6}" y="${y + 16}" font-size="13">${entry.value}</text>`
      )
    })
    .join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" font-family="system-ui, sans-serif"><text x="0" y="22" font-size="16" font-weight="600">${escapeXml(input.title)}</text>${bars}</svg>`
  const summary = `Chart "${input.title}": ${input.series.map((entry) => `${entry.label} ${entry.value}`).join(", ")}.`
  return [
    { type: "text", text: summary },
    { type: "image", source: { type: "data", value: base64(svg), mimeType: "image/svg+xml" } },
  ]
}
