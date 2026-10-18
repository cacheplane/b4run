// @vitest-environment jsdom
import { renderToString } from "react-dom/server"
import { expect, it } from "vitest"
import demoMedia from "../../../lib/demo-media.json"
import { NAVLOG_DEMO_URL } from "../../site-links"
import { DemoVideo } from "./DemoVideo"

const render = () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<DemoVideo />)
  return container
}

it("plays the uploaded navlog demo, loading nothing before play", () => {
  const video = render().querySelector("#demo video")
  expect(video).not.toBeNull()
  expect(video?.hasAttribute("controls")).toBe(true)
  expect(video?.hasAttribute("autoplay")).toBe(false)
  expect(video?.getAttribute("preload")).toBe("none")
  expect(video?.getAttribute("poster")).toBe(demoMedia.productLoop.poster)
  expect(video?.getAttribute("aria-label")).toBe(demoMedia.productLoop.ariaLabel)
  const sources = [...(video?.querySelectorAll("source") ?? [])].map((source) => [
    source.getAttribute("type"),
    source.getAttribute("src"),
  ])
  expect(sources).toEqual([
    ["video/webm", demoMedia.productLoop.webm],
    ["video/mp4", demoMedia.productLoop.mp4],
  ])
})

it("links the live demo, the build write-up and the transcript", () => {
  const links = [...render().querySelectorAll("figcaption a")].map((link) => [
    link.textContent,
    link.getAttribute("href"),
  ])
  expect(links).toEqual([
    ["Fly it live", NAVLOG_DEMO_URL],
    ["How we built it", "/blog/how-we-built-navlog"],
    ["Transcript", demoMedia.productLoop.transcript],
  ])
})
