import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { INSPECTOR_LESSONS } from "../../../lib/turn-inspector/lessons"
import { DOCS_VIDEOS } from "../../../lib/turn-inspector/videos"
import { DocsVideo } from "./DocsVideo"

test("video assets are digest-pinned and every clip links to its matching live take", () => {
  for (const clip of Object.values(DOCS_VIDEOS)) {
    const lesson = INSPECTOR_LESSONS.find((l) => l.id === clip.lesson)
    expect(lesson).toBeDefined()
    if (!lesson) throw new Error("Missing matching lesson")
    expect(clip.transcript).toBe(lesson.transcript)
    for (const url of [clip.src, clip.poster, clip.captions, clip.transcript]) {
      const match = url.match(/^\/docs-recordings\/([a-f0-9]{64})\.(mp4|png|vtt|txt)$/)
      expect(match).not.toBeNull()
      if (!match) throw new Error("Invalid asset URL")
      const bytes = readFileSync(new URL(`../../../public${url}`, import.meta.url))
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(match[1])
    }
    const captions = readFileSync(
      new URL(`../../../public${clip.captions}`, import.meta.url),
      "utf8",
    )
    expect(captions.startsWith("WEBVTT")).toBe(true)
    const ends = [...captions.matchAll(/--> (\d+):(\d+):(\d+)\.(\d+)/g)].map(
      (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
    )
    expect(ends.length).toBeGreaterThan(0)
    expect(Math.max(...ends)).toBeLessThanOrEqual(clip.duration)
  }
})
test("video has native controls, captions and transcript without autoplay or eager loading", () => {
  const markup = renderToStaticMarkup(<DocsVideo clip="lesson" />)
  expect(markup).toContain('preload="none"')
  expect(markup).toContain('controls=""')
  expect(markup).toContain('kind="captions"')
  expect(markup).toContain("Read the full transcript")
  expect(markup).not.toMatch(/autoPlay|autoplay/)
})
