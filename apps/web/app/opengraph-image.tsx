import { ImageResponse } from "next/og"

export const runtime = "edge"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"
export const alt = "B4.run — TypeScript meta-framework for LangGraph.js"

const PAGE = "#ffffff"
const SURFACE = "#fafaf7"
const INK = "#14110d"
const INK_MUTED = "#5a554c"
const INK_DIM = "#8a857b"
const DIVIDER = "#e6e3da"
const ACCENT = "#b45309"

// B4.run icon — inline SVG so the OG image doesn't depend on a network fetch.
// Sourced from public/brand/b4-icon-black.svg, paths preserved verbatim.
const B4_ICON = (
  // biome-ignore lint/a11y/noSvgWithoutTitle: rasterized to PNG by satori; OG image alt is set via `alt` export
  <svg width={88} height={88} viewBox="-5 -5 190 115" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(0.0000 0)" fill={INK}>
      <path
        d="M0 4Q0 0 4 0H22V35C28 26 37 23 47 23C69 23 82 40 82 64C82 89 67 103 45 103C33 103 25 99 21 92V100H0Z M21 64C21 80 28 89 41 89C55 89 62 78 62 64C62 48 54 38 42 38C28 38 21 48 21 64Z"
        fillRule="evenodd"
      />
    </g>
    <g transform="translate(94 0)" fill={INK}>
      <path d="M17 12H37L18 59H54V0H74V59H86V79H74V100H54V79H0V59Z" fillRule="evenodd" />
    </g>
  </svg>
)

export default function OG() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        background: PAGE,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* Top: brand */}
      <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
        {B4_ICON}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "44px", fontWeight: 700, color: INK, letterSpacing: "-0.02em" }}>
            B4.run
          </span>
          <span style={{ fontSize: "20px", color: INK_MUTED, marginTop: "4px" }}>
            TypeScript meta-framework · for LangGraph.js
          </span>
        </div>
      </div>

      {/* Middle: headline */}
      <div style={{ display: "flex", flexDirection: "column", maxWidth: "1000px" }}>
        <span
          style={{
            fontSize: "84px",
            lineHeight: 1.05,
            fontWeight: 700,
            color: INK,
            letterSpacing: "-0.025em",
            display: "flex",
          }}
        >
          Build LangGraph agents like Next.js apps.
        </span>
        <span
          style={{
            fontSize: "28px",
            color: INK_MUTED,
            marginTop: "28px",
            lineHeight: 1.4,
            display: "flex",
          }}
        >
          File-system routing, shared and route-local tools, generated types.
        </span>
      </div>

      {/* Bottom: bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: "24px",
          borderTop: `1px solid ${DIVIDER}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            fontSize: "20px",
            color: INK_DIM,
          }}
        >
          <span>BUILT ON</span>
          <span style={{ color: INK, fontWeight: 600 }}>LangGraph.js</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "20px",
            fontFamily: "ui-monospace, monospace",
            color: INK,
            background: SURFACE,
            border: `1px solid ${DIVIDER}`,
            padding: "10px 18px",
            borderRadius: "8px",
          }}
        >
          <span style={{ color: ACCENT }}>$</span>
          <span>npm create b4-app@latest my-agent</span>
        </div>
      </div>
    </div>,
    { ...size },
  )
}
