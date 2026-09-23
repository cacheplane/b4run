/** Every `--name: value;` inside the `@theme { … }` block. Parses the first `@theme` block only. */
export function themeTokens(css: string): Record<string, string> {
  const block = /@theme\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? ""
  const out: Record<string, string> = {}
  // `[\w*-]` so the wildcard resets (`--radius-*: initial`) are captured too.
  for (const m of block.matchAll(/^\s*(--[\w*-]+):\s*([^;]+);/gm))
    out[m[1] as string] = (m[2] as string).trim()
  return out
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}
