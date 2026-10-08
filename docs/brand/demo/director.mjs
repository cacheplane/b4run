import { readFileSync } from "node:fs"

/** The four beats, in recording order. */
export const BEATS = Object.freeze(["author", "prove", "run", "close"])

export const HEADLINES = Object.freeze({
  author: "Write the agent.",
  prove: "Test it offline.",
  run: "Reload. Still there.",
  close: "Ridiculous speed. Readable code.",
})

/** Every duration the director page waits on, in milliseconds. */
export const DIRECTOR_TIMING = Object.freeze({
  wordStaggerMs: 45,
  wordRevealMs: 380,
  readMs: 800,
  dockMs: 420,
  swapMs: 550,
  cameraMs: 700,
  holdMs: 1200,
  closeSweepMs: 750,
  closeHoldMs: 1800,
})

/**
 * Camera presets for the Run beat, over the Workbench as the frame shows it:
 * the chat dock's answer on the left, the navlog sheet's numbers along the
 * bottom. The Workbench lays out at a fixed 1440x810 inside the frame, so
 * fixed presets are enough.
 */
export const RUN_FOCUS = Object.freeze({
  rest: Object.freeze({ scale: 1, origin: "50% 50%" }),
  answer: Object.freeze({ scale: 1.6, origin: "8% 62%" }),
  sheet: Object.freeze({ scale: 1.45, origin: "70% 94%" }),
})

/** Lines of the test log the prove panel shows around its focal summary line. */
export const PROVE_LOG_WINDOW = Object.freeze({ before: 18, after: 2 })

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

/** Escaped lines, with the first line matching `focal` wrapped as the beat's focal mark. */
function markedCode(source, focal, missing) {
  const lines = source.split("\n")
  const index = lines.findIndex((line) => focal.test(line))
  if (index === -1) throw new Error(missing)
  return lines
    .map((line, at) => (at === index ? `<span class="focus">${escapeHtml(line)}</span>` : escapeHtml(line)))
    .join("\n")
}

/** The last Vitest test-count line, else the last broader passing line, with its surrounding window. */
function windowedLog(testLog) {
  const lines = testLog.split("\n")
  const lastMatch = (pattern) => lines.findLastIndex((line) => pattern.test(line))
  let index = lastMatch(/^\s*Tests\s+\d+\s+passed/u)
  if (index === -1) index = lastMatch(/(?:Tests?\s+.*passed|\d+\s+passed)/iu)
  if (index === -1) throw new Error("test log has no passing summary")
  const start = Math.max(0, index - PROVE_LOG_WINDOW.before)
  return {
    lines: lines.slice(start, index + PROVE_LOG_WINDOW.after + 1),
    focusIndex: index - start,
  }
}

const STYLE = `
@font-face { font-family: "Inter"; font-weight: 400; src: url("fonts/Inter-400.ttf") format("truetype"); }
@font-face { font-family: "Inter"; font-weight: 600; src: url("fonts/Inter-600.ttf") format("truetype"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("fonts/JetBrainsMono-400.ttf") format("truetype"); }
:root {
  --paper: #f5f4f0; --ink: #111111; --ink-muted: #595b53; --rule-strong: #75796a;
  --panel: #17181b; --panel-strip: #202226; --panel-ink: #f5f4f0; --panel-dim: #a3aa99;
  --relay: #b4ce37; --relay-wash: rgb(180 206 55 / 0.16);
  --ease-out: cubic-bezier(.16, 1, .3, 1); --ease-in-out: cubic-bezier(.65, 0, .35, 1);
}
* { box-sizing: border-box; margin: 0; }
html, body { width: 1440px; height: 810px; overflow: hidden; background: var(--paper); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.stage { position: relative; width: 1440px; height: 810px; overflow: hidden; }
.head { position: absolute; left: 163px; top: 44px; font-weight: 600; font-size: 88px; line-height: 1.06; letter-spacing: -0.055em; transform-origin: 0 0; transform: translateY(300px); transition: transform var(--dock) var(--ease-out); white-space: nowrap; }
.docked .head { transform: scale(0.42); }
.roll { overflow: hidden; height: 1.12em; }
.lines { transition: transform var(--swap) var(--ease-in-out); }
.rolling .lines { transform: translateY(-1.12em); }
.instant, .instant * { transition: none !important; }
.w { display: inline-block; overflow: hidden; vertical-align: bottom; padding-bottom: 0.06em; margin-right: 0.22em; }
.w > span { display: inline-block; transform: translateY(105%); transition: transform var(--reveal) var(--ease-out); }
.revealed .head .w > span, .close-revealed .close .w > span { transform: none; }
.frame { position: absolute; left: 163px; top: 128px; width: 1113px; height: 626px; overflow: hidden; outline: 1px solid var(--rule-strong); background: var(--panel); transform: translateY(820px); transition: transform var(--dock) var(--ease-out); }
.docked .frame, .prep .frame { transform: none; }
.camera { position: absolute; inset: 0; transition: transform var(--camera) var(--ease-in-out); }
.layer { position: absolute; inset: 0; opacity: 0; filter: blur(6px); transform: scale(1.03); transition: opacity var(--swap) var(--ease-in-out), filter var(--swap) var(--ease-in-out), transform var(--swap) var(--ease-in-out); }
.layer.on { opacity: 1; filter: none; transform: none; }
.strip { height: 40px; padding: 11px 24px; background: var(--panel-strip); color: var(--panel-dim); font: 400 14px/18px "JetBrains Mono", ui-monospace, monospace; }
pre { padding: 24px; color: var(--panel-ink); font: 400 17px/1.65 "JetBrains Mono", ui-monospace, monospace; white-space: pre; overflow: hidden; }
.author { display: grid; grid-template-rows: 1fr 0.62fr; }
.author > div + div { border-top: 1px solid #4d5148; }
.focus { position: relative; z-index: 0; }
.focus::before { content: ""; position: absolute; left: -24px; right: -2000px; top: -2px; bottom: -2px; background: var(--relay-wash); box-shadow: inset 3px 0 0 var(--relay); transform: scaleX(0); transform-origin: 0 50%; transition: transform var(--swap) var(--ease-out); z-index: -1; }
.marked .focus::before { transform: none; }
.run { background: var(--paper); }
.run iframe { position: absolute; left: 0; top: 0; width: 1440px; height: 810px; border: 0; transform: scale(0.772917); transform-origin: 0 0; }
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

const RUNTIME = `
(() => {
  const T = TIMING, H = HEADLINES_JSON, FOCUS = FOCUS_JSON
  const stage = document.querySelector(".stage")
  const roll = stage.querySelector(".roll")
  const lines = stage.querySelector(".lines")
  const camera = stage.querySelector(".camera")
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  for (const [name, value] of [["--dock", T.dockMs], ["--swap", T.swapMs], ["--reveal", T.wordRevealMs], ["--camera", T.cameraMs], ["--sweep", T.closeSweepMs]]) {
    stage.style.setProperty(name, value + "ms")
  }
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
  const revealMs = (text) => T.wordRevealMs + (text.split(" ").length - 1) * T.wordStaggerMs
  function show(layer) {
    for (const element of stage.querySelectorAll(".layer")) element.classList.toggle("on", element.dataset.layer === layer)
  }
  async function cameraTo(scale, origin) {
    if (scale !== 1) camera.style.transformOrigin = origin
    camera.style.transform = scale === 1 ? "none" : "scale(" + scale + ")"
    await wait(T.cameraMs)
  }
  async function focusOn(layer, scale) {
    const mark = stage.querySelector('[data-layer="' + layer + '"] .focus')
    const box = mark.getBoundingClientRect(), view = camera.getBoundingClientRect()
    const y = ((box.top + box.height / 2 - view.top) / view.height) * 100
    stage.classList.add("marked")
    await cameraTo(scale, "0% " + y.toFixed(2) + "%")
  }
  async function rollTo(text) {
    lines.append(words(text))
    stage.classList.remove("marked")
    roll.classList.add("rolling")
    await wait(T.swapMs)
    roll.classList.add("instant")
    lines.firstElementChild.remove()
    roll.classList.remove("rolling")
    await frame()
    roll.classList.remove("instant")
  }
  async function play(beat) {
    if (beat === "author") {
      lines.replaceChildren(words(H.author))
      await frame()
      stage.classList.add("revealed")
      await wait(revealMs(H.author) + T.readMs)
      show("author")
      stage.classList.add("docked")
      await wait(T.dockMs)
      await focusOn("author", 1.35)
      await wait(T.holdMs)
      return
    }
    if (beat === "prove" || beat === "run") {
      const settle = cameraTo(1, "50% 50%")
      show(beat)
      await rollTo(H[beat])
      await settle
      if (beat === "prove") {
        await focusOn("prove", 1.5)
        await wait(T.holdMs)
      }
      return
    }
    if (beat === "close") {
      stage.classList.add("closing")
      await wait(T.closeSweepMs)
      stage.classList.add("swept", "close-revealed")
      await wait(revealMs(H.close) + T.closeHoldMs)
      return
    }
    throw new Error("unknown beat " + beat)
  }
  async function focus(target) {
    const preset = FOCUS[target]
    if (preset === undefined) throw new Error("unknown focus " + target)
    await cameraTo(preset.scale, preset.origin)
  }
  /** Leaves the Workbench preparation state for the opening frame, with no motion. */
  async function reset() {
    stage.classList.add("instant")
    stage.classList.remove("prep")
    show(null)
    await frame()
    stage.classList.remove("instant")
    await frame()
  }
  window.director = { play, focus, reset, ready: true }
})()
`

/**
 * The director page: paper stage, docking headline, square product frame, and
 * the closing card. It starts in the preparation state (frame in place, the
 * Workbench layer showing) so the capture can load and fill the Workbench
 * before recording the beats; `director.reset()` then moves to the opening
 * frame without animating.
 */
export function renderDirector({ routeSource, toolSource, testLog, wordmark = wordmarkSvg() }) {
  requireString(routeSource, "routeSource")
  requireString(toolSource, "toolSource")
  requireString(testLog, "testLog")
  requireString(wordmark, "wordmark")
  const route = markedCode(routeSource, /^\s*description:/u, "route source has no description line")
  const { lines: proofLines, focusIndex } = windowedLog(testLog)
  const proof = proofLines
    .map((line, at) => (at === focusIndex ? `<span class="focus">${escapeHtml(line)}</span>` : escapeHtml(line)))
    .join("\n")
  const runtime = RUNTIME.replace("TIMING", JSON.stringify(DIRECTOR_TIMING))
    .replace("HEADLINES_JSON", JSON.stringify(HEADLINES))
    .replace("FOCUS_JSON", JSON.stringify(RUN_FOCUS))
  const closeWords = HEADLINES.close
    .split(" ")
    .map((word, index) => `<span class="w"><span style="transition-delay:${index * DIRECTOR_TIMING.wordStaggerMs}ms">${escapeHtml(word)}</span></span>`)
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>B4.run demo</title>
<style>${STYLE}</style>
</head>
<body>
<div class="stage prep">
  <h1 class="head"><div class="roll"><div class="lines"></div></div></h1>
  <div class="frame"><div class="camera">
    <div class="layer author" data-layer="author">
      <div><div class="strip">server/src/app/navlog/index.ts</div><pre>${route}</pre></div>
      <div><div class="strip">server/src/tools/computeNavlog.ts</div><pre>${escapeHtml(toolSource)}</pre></div>
    </div>
    <div class="layer prove" data-layer="prove"><div class="strip">npm test</div><pre>${proof}</pre></div>
    <div class="layer run on" data-layer="run"><iframe name="workbench" src="about:blank" title="B4.run Workbench"></iframe></div>
  </div></div>
  <div class="close">${wordmark}<div class="tagline">${closeWords}</div><div class="command">npm create b4-app@latest my-agent</div></div>
  <div class="sweep"></div>
</div>
<script>${runtime}</script>
</body>
</html>`
}
