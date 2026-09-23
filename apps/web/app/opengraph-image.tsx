import { ImageResponse } from "next/og"
import { COLOR } from "../lib/design-tokens"

export const runtime = "edge"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"
export const alt = "B4.run: Ridiculous speed. Readable code."

// Supplied D2.2 wordmark, unchanged geometry; embedded for a network-free logo.
const wordmark =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9Ii01IC01IDUyMiAxMTUiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0iYjQucnVuIj4KPHRpdGxlPmI0LnJ1biAvIEQyLjIgLyB3b3JkbWFyazwvdGl0bGU+CjxkZXNjPlNlbGVjdGVkIEQyLjIgd29ya2luZyBpZGVudGl0eS4gQ3VzdG9tIG5hdGl2ZSB2ZWN0b3IgZ2VvbWV0cnk7IHRyYW5zcGFyZW50IGJhY2tncm91bmQ7IG5vIGZvbnQgZGVwZW5kZW5jaWVzLjwvZGVzYz4KPGcgaWQ9ImxldHRlci1iIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjAwMDAgMCkiIGZpbGw9IiMxMTExMTEiPgo8cGF0aCBkPSJNMCA0UTAgMCA0IDBIMjNWMzVDMzAgMjYgNDAgMjMgNTEgMjNDNzUgMjMgODkgNDAgODkgNjRDODkgODkgNzMgMTAzIDQ5IDEwM0MzNiAxMDMgMjggOTkgMjIgOTJWMTAwSDBaIE0yMiA2NEMyMiA4MCAzMSA4OSA0NiA4OUM2MSA4OSA2OSA3OCA2OSA2NEM2OSA0OCA2MCAzOCA0NiAzOEMzMSAzOCAyMiA0OCAyMiA2NFoiIGZpbGwtcnVsZT0iZXZlbm9kZCIgLz4KPC9nPgo8ZyBpZD0ibnVtZXJhbC00IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMDUgMCkiIGZpbGw9IiMxMTExMTEiPgo8cGF0aCBkPSJNMTkgMTJINDBMMjAgNTlINjFWMEg4MlY1OUg5NFY3OUg4MlYxMDBINjFWNzlIMFY1OVoiIGZpbGwtcnVsZT0iZXZlbm9kZCIgLz4KPC9nPgo8ZyBpZD0iZG9tYWluLWRvdCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMjE2IDApIiBmaWxsPSIjMTExMTExIj4KPGNpcmNsZSBjeD0iMTciIGN5PSI4MyIgcj0iMTciIC8+CjwvZz4KPGcgaWQ9ImxldHRlci1yIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyNjkgMCkiIGZpbGw9IiMxMTExMTEiPgo8cGF0aCBkPSJNMCAyNUgyMUwyMiA0MEMyOCAyNyAzOSAyMSA1NSAyNUw1MSA0NUMzMiA0MiAyNCA1MiAyNCA2OVYxMDBIMFoiIGZpbGwtcnVsZT0iZXZlbm9kZCIgLz4KPC9nPgo8ZyBpZD0ibGV0dGVyLXUiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDMzNiAwKSIgZmlsbD0iIzExMTExMSI+CjxwYXRoIGQ9Ik0wIDI1SDI0VjcwQzI0IDgyIDI4IDg4IDM4IDg4QzQ5IDg4IDU1IDgxIDU1IDY5VjI1SDc5VjEwMEg1OEw1NiA5MEM0OSAxMDAgNDEgMTA1IDI4IDEwNUM5IDEwNSAwIDkzIDAgNzNaIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIC8+CjwvZz4KPGcgaWQ9ImxldHRlci1uIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg0MzAgMCkiIGZpbGw9IiMxMTExMTEiPgo8cGF0aCBkPSJNMCAyNUgyMUwyMyAzN0MzMCAyNyA0MCAyMiA1MyAyMkM3MyAyMiA4MiAzNSA4MiA1NFYxMDBINThWNThDNTggNDUgNTQgMzkgNDQgMzlDMzIgMzkgMjQgNDggMjQgNjNWMTAwSDBaIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIC8+CjwvZz4KPC9zdmc+"

export default async function OG() {
  const font = await fetch(
    new URL("../public/brand/identity/fonts/Inter-600.ttf", import.meta.url),
  ).then((response) => response.arrayBuffer())
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        background: COLOR.page,
        color: COLOR.ink,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "60px 72px",
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {/* biome-ignore lint/performance/noImgElement: ImageResponse renders the supplied SVG into a PNG. */}
        <img src={wordmark} width={190} height={42} alt="b4.run" />
        <span style={{ fontSize: 20, color: COLOR["ink-muted"] }}>
          The TypeScript framework for agents.
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 88,
            lineHeight: 1.04,
            letterSpacing: "-0.055em",
          }}
        >
          <span>Ridiculous speed.</span>
          <span>Readable code.</span>
        </div>
        <div
          style={{
            width: 108,
            height: 108,
            borderRadius: "50%",
            background: COLOR.relay,
            display: "flex",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          borderTop: `1px solid ${COLOR.rule}`,
          paddingTop: 24,
          justifyContent: "space-between",
          fontSize: 22,
        }}
      >
        <span>Write the agent in TypeScript. Ship code you can read.</span>
        <span style={{ color: COLOR["ink-muted"] }}>b4.run</span>
      </div>
    </div>,
    { ...size, fonts: [{ name: "Inter", data: font, weight: 600, style: "normal" }] },
  )
}
