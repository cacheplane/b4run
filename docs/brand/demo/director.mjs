import { readFileSync } from "node:fs"
import { APP_FOCUS, STORYBOARD } from "./storyboard.mjs"

/** Every motion duration the director page waits on, in milliseconds. Holds live in the storyboard. */
export const DIRECTOR_TIMING = Object.freeze({
  wordStaggerMs: 45,
  wordRevealMs: 380,
  readMs: 800,
  dockMs: 420,
  swapMs: 550,
  cameraMs: 700,
  closeSweepMs: 750,
})

/**
 * Lines a code pane shows: one pane fills the frame at 17px, two side by side
 * at 15px. A file this short or shorter shows whole; a longer one shows a
 * window around its focal line, so the focal line is always on screen before
 * the camera moves.
 */
export const CODE_PANE_LINES = Object.freeze({ one: 19, two: 23 })

/** Lines a window keeps below the focal line; the rest go above it. */
const CODE_CONTEXT_AFTER = Object.freeze({ one: 6, two: 8 })

/** How far back a window's start may move to reach a block boundary. */
const SNAP_BACK_LINES = 6

/** A line that opens a block: the file's first line, one after a blank line, or a doc comment. */
const opensBlock = (lines, at) =>
  lines[at].trim() !== "" &&
  (at === 0 || lines[at - 1].trim() === "" || lines[at].trim().startsWith("/**"))

/**
 * The start of a window of `size` lines that shows line `index`, moved to a
 * block boundary so the pane never opens mid-function: back up to
 * SNAP_BACK_LINES lines, else forward to the nearest boundary that still
 * leaves a line above the focal one, else unchanged.
 */
export function snapWindowStart(lines, start, index, size) {
  for (let at = start; at >= Math.max(0, start - SNAP_BACK_LINES); at--) {
    if (opensBlock(lines, at) && index - at < size) return at
  }
  for (let at = start + 1; at < index && at + size <= lines.length; at++) {
    if (opensBlock(lines, at)) return at
  }
  return start
}

/** Font files the page loads, served by the capture from the brand kit. */
export const DIRECTOR_FONTS = Object.freeze({
  "Inter-400.ttf": "apps/web/public/brand/identity/fonts/Inter-400.ttf",
  "Inter-600.ttf": "apps/web/public/brand/identity/fonts/Inter-600.ttf",
  "JetBrainsMono-400.ttf": "apps/web/public/brand/identity/fonts/JetBrainsMono-400.ttf",
})

const WORDMARK_MASTER = new URL(
  "../../../apps/web/public/brand/identity/logos/wordmark-ink.svg",
  import.meta.url,
)

/** The ink wordmark master, inline-ready: no title or description. */
export function wordmarkSvg(read = readFileSync) {
  return read(WORDMARK_MASTER, "utf8")
    .replace(/<\?xml[^>]*>/u, "")
    .replace(/<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>/gu, "")
    .replace(/\n\s*\n/gu, "\n")
    .trim()
}

/**
 * A fixed-size window of `lines` around `index`: `before` lines above and
 * `after` below, shifted (never shrunk) where the file starts or ends, and the
 * whole file when it is shorter than the window.
 */
export function windowAround(lines, index, { before, after }) {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new RangeError(`index ${index} is outside the ${lines.length} lines`)
  }
  const size = before + 1 + after
  const start = Math.max(0, Math.min(index - before, lines.length - size))
  return { lines: lines.slice(start, start + size), start, focusIndex: index - start }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function requireString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`)
}

/** A stateless copy of a pattern, so `test` and `exec` never carry `lastIndex` between lines. */
const stateless = (pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, ""))

/**
 * One pane's lines: the file's single focal line found, the window chosen, and
 * the focal line wrapped as the beat's mark, with the matched part as the
 * `hit` the camera keeps in view (`part` when it is less than the whole line).
 */
function codePane(beat, pane, files, density) {
  const source = files[pane.path]
  if (typeof source !== "string") {
    throw new Error(`storyboard beat "${beat.id}" needs ${pane.path}, which files does not include`)
  }
  const focal = stateless(pane.focal)
  const all = source.replace(/\n$/u, "").split("\n")
  const matches = all.flatMap((line, at) => (focal.test(line) ? [at] : []))
  if (matches.length === 0) {
    throw new Error(`storyboard beat "${beat.id}": no line of ${pane.path} matches ${pane.focal}`)
  }
  if (matches.length > 1) {
    throw new Error(
      `storyboard beat "${beat.id}": ${matches.length} lines of ${pane.path} match ${pane.focal}; it must mark one`,
    )
  }
  const size = CODE_PANE_LINES[density]
  const after = CODE_CONTEXT_AFTER[density]
  let lines = all
  let focusIndex = matches[0]
  if (all.length > size) {
    const { start } = windowAround(all, matches[0], { before: size - 1 - after, after })
    const snapped = snapWindowStart(all, start, matches[0], size)
    lines = all.slice(snapped, snapped + size)
    focusIndex = matches[0] - snapped
  }
  const body = lines
    .map((line, at) => {
      if (at !== focusIndex) return escapeHtml(line)
      const match = focal.exec(line)
      // The hit is the match without surrounding whitespace, so a pattern
      // anchored with `^\s+` still frames the code, not its indent.
      const from = match.index + (match[0].length - match[0].trimStart().length)
      const to = match.index + match[0].trimEnd().length
      const part = line.slice(from, to) !== line.trim() ? " part" : ""
      return `<span class="focus">${escapeHtml(line.slice(0, from))}<span class="hit${part}">${escapeHtml(line.slice(from, to))}</span>${escapeHtml(line.slice(to))}</span>`
    })
    .join("\n")
  return {
    html: `<section class="pane"><div class="strip">${escapeHtml(pane.path)}</div><pre>${body}</pre></section>`,
    weight: Math.max(44, all[matches[0]].trimEnd().length + 4),
  }
}

function codeLayer(beat, files) {
  const density = beat.panes.length === 2 ? "two" : "one"
  const panes = beat.panes.map((pane) => codePane(beat, pane, files, density))
  const columns =
    density === "two" ? ` style="grid-template-columns: ${panes.map((pane) => `${pane.weight}fr`).join(" ")}"` : ""
  return `<div class="layer code${density === "two" ? " two" : ""}" data-layer="${beat.id}"${columns}>${panes.map((pane) => pane.html).join("")}</div>`
}

/** Words that rise one by one, each its own clipped box; `from` offsets the stagger. */
function revealWords(text, from = 0) {
  return text
    .split(" ")
    .map(
      (word, index) =>
        `<span class="w"><span style="transition-delay:${(from + index) * DIRECTOR_TIMING.wordStaggerMs}ms">${escapeHtml(word)}</span></span>`,
    )
    .join("")
}

/** JSON safe inside an inline script. */
const scriptJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c")

const STYLE = `
@font-face { font-family: "Inter"; font-weight: 400; src: url("fonts/Inter-400.ttf") format("truetype"); }
@font-face { font-family: "Inter"; font-weight: 600; src: url("fonts/Inter-600.ttf") format("truetype"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("fonts/JetBrainsMono-400.ttf") format("truetype"); }
:root {
  --paper: #f5f4f0; --ink: #111111; --ink-muted: #595b53; --rule-strong: #75796a;
  --panel: #17181b; --panel-strip: #202226; --panel-ink: #f5f4f0; --panel-dim: #a3aa99; --panel-rule: #4d5148;
  --relay: #b4ce37; --relay-wash: rgb(180 206 55 / 0.16);
  --ease-out: cubic-bezier(.16, 1, .3, 1); --ease-in-out: cubic-bezier(.65, 0, .35, 1);
}
* { box-sizing: border-box; margin: 0; }
html, body { width: 1440px; height: 810px; overflow: hidden; background: var(--paper); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.stage { position: relative; width: 1440px; height: 810px; overflow: clip; }
.instant, .instant * { transition: none !important; }
.w { display: inline-block; overflow: hidden; vertical-align: bottom; padding-bottom: 0.06em; margin-right: 0.22em; }
.w:last-child { margin-right: 0; }
.w > span { display: inline-block; transform: translateY(105%); transition: transform var(--reveal) var(--ease-out); }
.revealed .head .w > span, .titled .title .w > span, .close-revealed .close .w > span { transform: none; }
.title { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 20px; pointer-events: none; transition: opacity var(--swap) var(--ease-in-out), filter var(--swap) var(--ease-in-out), transform var(--swap) var(--ease-in-out); }
.title .name { font-weight: 600; font-size: 184px; line-height: 1.04; letter-spacing: -0.045em; white-space: nowrap; }
.title .sub { font-size: 36px; line-height: 1.2; letter-spacing: -0.02em; color: var(--ink-muted); white-space: nowrap; }
.untitled .title { opacity: 0; filter: blur(6px); transform: scale(0.98); }
.head { position: absolute; left: 163px; top: 44px; font-weight: 600; font-size: 88px; line-height: 1.06; letter-spacing: -0.055em; transform-origin: 0 0; transform: translateY(300px); transition: transform var(--dock) var(--ease-out); white-space: nowrap; }
.docked .head { transform: scale(0.42); }
.roll { overflow: hidden; height: 1.12em; }
.lines { transition: transform var(--swap) var(--ease-in-out); }
.rolling .lines { transform: translateY(-1.12em); }
.frame { position: absolute; left: 163px; top: 128px; width: 1113px; height: 626px; overflow: clip; outline: 1px solid var(--rule-strong); background: var(--panel); transform: translateY(820px); transition: transform var(--dock) var(--ease-out); }
.docked .frame, .prep .frame { transform: none; }
.camera { position: absolute; inset: 0; transform-origin: 0 0; transform: translate(0px, 0px) scale(1); transition: transform var(--camera) var(--ease-in-out); }
.layer { position: absolute; inset: 0; opacity: 0; filter: blur(6px); transform: scale(1.03); transition: opacity var(--swap) var(--ease-in-out), filter var(--swap) var(--ease-in-out), transform var(--swap) var(--ease-in-out); }
.layer.on { opacity: 1; filter: none; transform: none; }
.layer:not(.on) { pointer-events: none; }
.code { display: grid; grid-template-columns: 1fr; }
.pane { min-width: 0; overflow: clip; }
.pane + .pane { border-left: 1px solid var(--panel-rule); }
.strip { height: 40px; padding: 11px 24px; background: var(--panel-strip); color: var(--panel-dim); font: 400 14px/18px "JetBrains Mono", ui-monospace, monospace; white-space: nowrap; overflow: hidden; }
pre { padding: 24px; color: var(--panel-ink); font: 400 17px/1.65 "JetBrains Mono", ui-monospace, monospace; font-variant-ligatures: none; white-space: pre; overflow: hidden; transition: color var(--swap) var(--ease-out); }
.two .strip { padding: 11px 20px; }
.two pre { padding: 24px 20px; font-size: 15px; line-height: 1.6; }
.focus { position: relative; z-index: 0; }
.focus::before { content: ""; position: absolute; left: -24px; right: -2000px; top: -2px; bottom: -2px; background: var(--relay-wash); box-shadow: inset 3px 0 0 var(--relay); transform: scaleX(0); transform-origin: 0 50%; transition: transform var(--swap) var(--ease-out); z-index: -1; }
.two .focus::before { left: -20px; }
.marked .focus::before { transform: none; }
.focus, .hit { transition: color var(--swap) var(--ease-out); }
.marked pre { color: var(--panel-dim); }
.marked .focus { color: var(--panel-ink); }
.marked .focus:has(> .hit.part) { color: var(--panel-dim); }
.marked .hit { color: var(--panel-ink); }
.hit.part { text-decoration: underline 2px transparent; text-underline-offset: 5px; transition: text-decoration-color var(--swap) var(--ease-out); }
.marked .hit.part { text-decoration-color: var(--relay); }
.app { background: var(--paper); }
.app iframe { position: absolute; left: 0; top: 0; width: 1440px; height: 810px; border: 0; transform: scale(0.772917); transform-origin: 0 0; }
.close { position: absolute; inset: 0; z-index: 4; display: grid; place-content: center; justify-items: center; gap: 36px; background: var(--paper); clip-path: inset(0 0 0 100%); transition: clip-path var(--sweep) var(--ease-in-out); }
.closing .close { clip-path: inset(0 0 0 0); }
.close svg { width: 300px; height: auto; }
.close .tagline { font-weight: 600; font-size: 72px; line-height: 1.06; letter-spacing: -0.055em; white-space: nowrap; }
.close .command { padding: 18px 26px; background: var(--panel); color: var(--panel-ink); font: 400 20px/1 "JetBrains Mono", ui-monospace, monospace; }
.sweep { visibility: hidden; position: absolute; top: 0; bottom: 0; left: 1440px; width: 1px; z-index: 5; background: var(--rule-strong); transition: left var(--sweep) var(--ease-in-out); }
.sweep::after { content: ""; position: absolute; left: -11px; top: 394px; width: 22px; height: 22px; border-radius: 50%; background: var(--relay); }
.closing .sweep { left: 0; visibility: visible; }
.swept .sweep { visibility: hidden; }
`

/**
 * The page's runtime. The camera never changes its transform-origin (0 0): it
 * moves by `translate(x, y) scale(s)`, the same function list every time, so
 * the browser interpolates translate and scale together and a move between
 * any two framings, zoomed or not, is one continuous ease with no jump. (Take
 * 1 changed the origin only while at scale 1 for the same reason.)
 */
const runtime = (T, beats, presets) => `
(() => {
  const T = ${scriptJson(T)}, BEATS = ${scriptJson(beats)}, FOCUS = ${scriptJson(presets)}
  const stage = document.querySelector(".stage")
  const roll = stage.querySelector(".roll")
  const lines = stage.querySelector(".lines")
  const camera = stage.querySelector(".camera")
  const MARGIN = 48, CODE_ZOOM = { one: 1.4, two: 1 }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high)
  for (const [name, value] of [["--dock", T.dockMs], ["--swap", T.swapMs], ["--reveal", T.wordRevealMs], ["--camera", T.cameraMs], ["--sweep", T.closeSweepMs]]) {
    stage.style.setProperty(name, value + "ms")
  }
  let docked = false
  function words(text) {
    const line = document.createElement("div")
    text.split(" ").forEach((word, index) => {
      const outer = document.createElement("span"); outer.className = "w"
      const inner = document.createElement("span"); inner.textContent = word
      inner.style.transitionDelay = index * T.wordStaggerMs + "ms"
      outer.append(inner); line.append(outer)
    })
    return line
  }
  const revealMs = (count) => T.wordRevealMs + (count - 1) * T.wordStaggerMs
  const layerOf = (beat) => stage.querySelector('[data-layer="' + (beat.kind === "app" ? "app" : beat.id) + '"]')
  /** Crossfades to one layer; the one leaving keeps its focal bar until it has faded. */
  function show(layer) {
    for (const element of stage.querySelectorAll(".layer")) {
      const on = element === layer
      if (!on && element.classList.contains("on")) {
        setTimeout(() => { if (!element.classList.contains("on")) element.classList.remove("marked") }, T.swapMs)
      }
      element.classList.toggle("on", on)
    }
  }
  /** Eases the camera to a framing: \`p\` maps to \`t + s * p\`. */
  async function cameraTo({ s, x, y }) {
    camera.style.transform = "translate(" + x.toFixed(2) + "px, " + y.toFixed(2) + "px) scale(" + s + ")"
    await wait(T.cameraMs)
  }
  /** A preset's framing: zoom by \`scale\` holding the point at \`origin\` (percent of the camera) still. */
  function presetFraming(name) {
    const preset = FOCUS[name]
    if (preset === undefined) throw new Error("unknown focus " + name)
    const [ox, oy] = preset.origin.split(" ").map((part) => parseFloat(part) / 100)
    const s = preset.scale
    return { s, x: ox * camera.offsetWidth * (1 - s), y: oy * camera.offsetHeight * (1 - s) }
  }
  /**
   * A code layer's framing, in untransformed layer coordinates (rects divided
   * by whatever scale the camera and layer have now). The box runs from the
   * start of the leftmost pane with a focal hit to the hits' right end, and
   * from the top of the layer (the filename strip) to the hits' bottom. The
   * zoom never crops it: the top stays anchored, so the strip is always in
   * view, and the camera never pans left of a pane's start, so no line is cut
   * at its beginning and the focal bar's Relay edge stays on screen.
   */
  function focalFraming(layer) {
    const box = layer.getBoundingClientRect(), k = layer.offsetWidth / box.width
    const W = camera.offsetWidth, H = camera.offsetHeight
    let x0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const hit of layer.querySelectorAll(".hit")) {
      const r = hit.getBoundingClientRect(), pane = hit.closest(".pane").getBoundingClientRect()
      x0 = Math.min(x0, (pane.left - box.left) * k); x1 = Math.max(x1, (r.right - box.left) * k)
      y1 = Math.max(y1, (r.bottom - box.top) * k)
    }
    const zoom = layer.classList.contains("two") ? CODE_ZOOM.two : CODE_ZOOM.one
    const s = Math.max(1, Math.min(zoom, (W - MARGIN) / (x1 - x0), (H - MARGIN) / y1))
    return {
      s,
      x: clamp(Math.min(0, W - MARGIN - s * x1), -s * x0, 0),
      y: clamp(Math.min(0, H - MARGIN - s * y1), H - s * H, 0),
    }
  }
  async function rollTo(text) {
    lines.append(words(text))
    roll.classList.add("rolling")
    await wait(T.swapMs)
    roll.classList.add("instant")
    lines.firstElementChild.remove()
    roll.classList.remove("rolling")
    await frame()
    roll.classList.remove("instant")
  }
  /** Moves the camera to a beat's framing, marking a code layer's focal lines as it goes. */
  function frameBeat(beat, layer) {
    if (beat.kind === "app") return cameraTo(presetFraming(beat.focus))
    layer.classList.add("marked")
    return cameraTo(focalFraming(layer))
  }
  /** The first beat after the title, as take 1's author beat: headline big, then docked over the frame. */
  async function dock(beat, layer) {
    stage.classList.add("untitled")
    await wait(T.swapMs / 2)
    lines.replaceChildren(words(beat.headline))
    await frame()
    stage.classList.add("revealed")
    await wait(revealMs(beat.headline.split(" ").length) + T.readMs)
    show(layer)
    stage.classList.add("docked")
    docked = true
    await wait(T.dockMs)
    await frameBeat(beat, layer)
  }
  /**
   * Plays one storyboard beat and resolves when its motion has settled plus
   * its hold, except an app beat, which resolves as soon as its motion has
   * settled: the capture then performs the beat's real action in the
   * Workbench and holds for the beat's holdMs itself.
   */
  async function play(index) {
    const beat = BEATS[index]
    if (beat === undefined) throw new Error("unknown beat " + index)
    if (beat.kind === "title") {
      stage.classList.add("titled")
      await wait(revealMs(stage.querySelectorAll(".title .w").length) + beat.holdMs)
      return
    }
    if (beat.kind === "close") {
      stage.classList.add("closing")
      await wait(T.closeSweepMs)
      stage.classList.add("swept", "close-revealed")
      await wait(revealMs(beat.headline.split(" ").length) + beat.holdMs)
      return
    }
    const layer = layerOf(beat)
    if (!docked) {
      await dock(beat, layer)
    } else {
      const rolled = rollTo(beat.headline)
      show(layer)
      // Let the crossfade get under way before the camera leaves, so the move
      // reads as one motion from the old layer into the new one.
      await wait(T.swapMs / 2)
      await Promise.all([rolled, frameBeat(beat, layer)])
    }
    if (beat.kind === "code") await wait(beat.holdMs)
  }
  async function focus(name) {
    await cameraTo(presetFraming(name))
  }
  /** Leaves the Workbench preparation state for the opening frame, with no motion. */
  async function reset() {
    stage.classList.add("instant")
    stage.classList.remove("prep")
    show(null)
    for (const layer of stage.querySelectorAll(".layer")) layer.classList.remove("marked")
    camera.style.transform = "translate(0px, 0px) scale(1)"
    await frame()
    stage.classList.remove("instant")
    await frame()
  }
  window.director = { ready: true, reset, play, focus }
})()
`

/**
 * The director page for the storyboard: the title card, a code layer per code
 * beat, the one shared Workbench iframe layer (last, so it takes clicks), the
 * close card and the sweep. `files` maps each storyboard path (relative to the
 * generated app) to its source. The page starts in the preparation state
 * (frame in place, the Workbench showing) so the capture can load and fill
 * the Workbench first; `director.reset()` then moves to the opening frame
 * without animating, and `director.play(index)` plays `STORYBOARD[index]`.
 */
export function renderDirector({ files, wordmark = wordmarkSvg() }) {
  if (files === null || typeof files !== "object") throw new TypeError("files must be an object")
  requireString(wordmark, "wordmark")
  const layers = STORYBOARD.filter((beat) => beat.kind === "code").map((beat) => codeLayer(beat, files))
  const title = STORYBOARD.find((beat) => beat.kind === "title")
  const close = STORYBOARD.find((beat) => beat.kind === "close")
  const beats = STORYBOARD.map(({ id, kind, headline, holdMs, focus }) => ({
    id,
    kind,
    headline,
    holdMs,
    ...(focus !== undefined ? { focus } : {}),
  }))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>B4.run demo</title>
<style>${STYLE}</style>
</head>
<body>
<div class="stage prep">
  <div class="title"><div class="name">${revealWords(title.headline)}</div><div class="sub">${revealWords(title.subtitle, 1)}</div></div>
  <h1 class="head"><div class="roll"><div class="lines"></div></div></h1>
  <div class="frame"><div class="camera">
    ${layers.join("\n    ")}
    <div class="layer app on" data-layer="app"><iframe name="workbench" src="about:blank" title="B4.run Workbench"></iframe></div>
  </div></div>
  <div class="close">${wordmark}<div class="tagline">${revealWords(close.headline)}</div><div class="command">npm create b4-app@latest my-agent</div></div>
  <div class="sweep"></div>
</div>
<script>${runtime(DIRECTOR_TIMING, beats, APP_FOCUS)}</script>
</body>
</html>`
}
