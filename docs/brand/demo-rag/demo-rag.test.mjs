import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { tsImport } from "tsx/esm/api"

import { expectedRootToolSteps } from "../demo/capture.mjs"
import { renderDirector } from "../demo/director.mjs"
import { createTrimPlan } from "../demo/encode.mjs"
import { beatSceneName, storyboardPaths } from "../demo/storyboard.mjs"
import { OPENED_CHIP, OPENED_SECTION_TEXT, REQUIRED_APP_TEST } from "./capture.mjs"
import { checkRagMedia, RAG_CLIP } from "./check-media.mjs"
import { applyEdit, EDITS, OVERLAY_ROOT, REMOVED } from "./overlay.mjs"
import { CHECKER_CALLS, PARENT_CALLS, ragScenario } from "./scenario.mjs"
import { RAG_APP_ACTIONS, RAG_APP_FOCUS, RAG_POSTER_BEAT, RAG_STORYBOARD } from "./storyboard.mjs"

const REPO = join(import.meta.dirname, "../../..")
const TEMPLATE = join(REPO, "packages/devkit/templates/app-navlog")
const WORKSPACE = join(OVERLAY_ROOT, "server/workspace")

/** The overlay's real tools, run over the real workspace files. */
async function tools() {
  const load = (name) =>
    tsImport(pathToFileURL(join(OVERLAY_ROOT, `server/src/tools/${name}.ts`)).href, import.meta.url)
  const [searchPlans, readSection] = await Promise.all([load("searchPlans"), load("readSection")])
  const ctx = {
    signal: new AbortController().signal,
    fs: {
      readFile: (path) => readFile(join(WORKSPACE, path), "utf8"),
      listDir: (path = ".") => readdir(join(WORKSPACE, path)),
    },
  }
  const call = async ({ tool, args }) => {
    const module = { searchPlans, readSection }[tool]
    const output = await module.default(args, ctx)
    return { output, sources: module.display.sources(output) }
  }
  return { call }
}

test("the storyboard is the spec's eight beats, frozen, with app actions and camera presets", () => {
  assert.deepEqual(
    RAG_STORYBOARD.map((beat) => `${beat.id}:${beat.kind}`),
    [
      "title:title",
      "agent:code",
      "ask:app",
      "search:code",
      "cite:app",
      "checker:code",
      "checklist:app",
      "close:close",
    ],
  )
  assert.ok(Object.isFrozen(RAG_STORYBOARD) && RAG_STORYBOARD.every(Object.isFrozen))
  for (const beat of RAG_STORYBOARD.filter((b) => b.kind === "app")) {
    assert.ok(RAG_APP_ACTIONS.includes(beat.action), beat.id)
    assert.ok(RAG_APP_FOCUS[beat.focus], beat.id)
  }
  for (const name of ["todos", "steps", "answer", "reader"]) assert.ok(RAG_APP_FOCUS[name], name)
  assert.ok(RAG_STORYBOARD.some((beat) => beat.id === RAG_POSTER_BEAT))
  assert.equal(RAG_STORYBOARD[0].headline, "compliance")
  assert.equal(RAG_STORYBOARD.at(-1).headline, "Answers you can check.")
})

test("every focal pattern marks exactly one line of the overlay's real file", async () => {
  const files = Object.fromEntries(
    await Promise.all(
      storyboardPaths(RAG_STORYBOARD).map(async (path) => [
        path,
        await readFile(join(OVERLAY_ROOT, path), "utf8"),
      ]),
    ),
  )
  const html = renderDirector({
    files,
    wordmark: "<svg></svg>",
    storyboard: RAG_STORYBOARD,
    focus: RAG_APP_FOCUS,
  })
  assert.match(html, /hits\.map\(citation\)/u)
  assert.match(html, /allow: \[&quot;searchPlans&quot;, &quot;readSection&quot;\]/u)
  assert.match(html, />compliance</u)
  assert.match(html, /npm create b4-app@latest my-agent/u)
  assert.match(html, /"reader":\{"scale":1\.3/u)
})

test("the scenario fits the thread title, keeps aimock's prompts apart and never folds a root step", () => {
  const scenario = ragScenario()
  assert.ok(scenario.prompt.length <= 80)
  assert.ok(
    !scenario.checkInput.includes(scenario.prompt) &&
      !scenario.prompt.includes(scenario.checkInput),
  )
  const rootTools = scenario.parentTools.filter((tool) => tool !== "writeTodos" && tool !== "task")
  assert.deepEqual(expectedRootToolSteps(scenario.parentTools), rootTools)
  assert.equal(
    scenario.fixtures.length,
    PARENT_CALLS.length + 1 + CHECKER_CALLS.length + 1,
    "one fixture per scripted call and per reply",
  )
  assert.deepEqual([...new Set(scenario.checklist.map((row) => row.status))].sort(), [
    "Met",
    "Missing",
    "Partial",
  ])
  for (const row of scenario.checklist) {
    assert.match(
      scenario.answer,
      new RegExp(`\\| ${row.element} \\| \\*\\*${row.status}\\*\\* \\|`, "u"),
    )
  }
})

test("every scripted tool call runs over the real workspace and cites linked sources", async () => {
  const { call } = await tools()
  for (const scripted of [...PARENT_CALLS, ...CHECKER_CALLS].filter(
    (c) => c.tool !== "writeTodos" && c.tool !== "task",
  )) {
    const { sources } = await call(scripted)
    assert.ok(sources.length > 0, `${scripted.tool} ${JSON.stringify(scripted.args)} cites nothing`)
    for (const source of sources)
      assert.match(source.href, /^\/sources\/(fema|plans)\/[a-z0-9-]+\.md#[a-z0-9-]+$/u)
  }
  const opened = CHECKER_CALLS.find(
    (c) => c.tool === "readSection" && c.args.heading === "5. Communications",
  )
  const { output, sources } = await call(opened)
  assert.equal(sources[0].title, OPENED_CHIP)
  assert.ok(output.text.includes(OPENED_SECTION_TEXT))
})

test("the checklist's judgements match the sample plan's text", async () => {
  const plan = await readFile(join(WORKSPACE, "plans/sample-lakeview-county-eop.md"), "utf8")
  assert.match(plan, /^# Sample /mu)
  assert.match(plan, /updates it as needed\./u)
  assert.doesNotMatch(plan, /## \d+\. Administration/u)
  assert.match(plan, /names no backup if the radio system fails/u)
  for (const file of await readdir(join(WORKSPACE, "plans"))) {
    assert.match(await readFile(join(WORKSPACE, "plans", file), "utf8"), /^# Sample /u, file)
  }
  for (const file of await readdir(join(WORKSPACE, "fema"))) {
    assert.match(
      await readFile(join(WORKSPACE, "fema", file), "utf8"),
      /Excerpt adapted from FEMA CPG 101 v3\.1/u,
      file,
    )
  }
})

test("the overlay's edits each match the navlog template exactly as often as declared", async () => {
  for (const edit of EDITS) {
    const path = [join(TEMPLATE, edit.file), join(TEMPLATE, `${edit.file}.template`)].find(
      existsSync,
    )
    assert.ok(path, `${edit.file} is not in the navlog template`)
    const edited = applyEdit(await readFile(path, "utf8"), edit)
    assert.ok(edited.includes(edit.to))
  }
  assert.throws(
    () => applyEdit("a a", { file: "x", from: "a", to: "b", count: 1 }),
    /expected 1 of "a", found 2/u,
  )
  for (const kept of [
    "server/src/auth.ts",
    "server/src/thread-access.ts",
    "server/src/lib/read-only-paths.ts",
  ]) {
    assert.ok(!REMOVED.some((path) => kept.startsWith(path)), kept)
  }
})

test("the generated test the capture requires is the overlay's own", async () => {
  const source = await readFile(join(OVERLAY_ROOT, "server/test/search-plans.test.ts"), "utf8")
  assert.ok(source.includes(REQUIRED_APP_TEST))
})

test("the trim plan takes the poster from the checklist beat", () => {
  const scenes = {}
  RAG_STORYBOARD.forEach((beat, index) => {
    scenes[beatSceneName(index, beat)] = { startMs: index * 1_000, endMs: index * 1_000 + 900 }
  })
  const trim = createTrimPlan(
    { videoTimeline: { unit: "milliseconds", videoOffsetMs: 500, scenes } },
    { storyboard: RAG_STORYBOARD, posterBeat: RAG_POSTER_BEAT },
  )
  assert.equal(trim.start, 0.5)
  assert.equal(trim.duration, 7.9)
  assert.equal(trim.posterTime, 6.65)
})

test("the media check holds rag-loop to 1440x810, 30 fps, 45-75 s and 12 MB", async () => {
  const video = (codec, duration) => ({
    streams: [
      { codec_type: "video", codec_name: codec, width: 1440, height: 810, avg_frame_rate: "30/1" },
    ],
    format: { duration: String(duration) },
  })
  const poster = {
    streams: [{ codec_type: "video", codec_name: "webp", width: 1440, height: 810 }],
  }
  const probes = (duration) => async (path) =>
    path.endsWith(".mp4")
      ? video("h264", duration)
      : path.endsWith(".webm")
        ? video("vp9", duration)
        : poster
  assert.deepEqual(
    await checkRagMedia("/run", { probe: probes(50), size: async () => 9_000_000 }),
    [],
  )
  const short = await checkRagMedia("/run", { probe: probes(40), size: async () => 9_000_000 })
  assert.equal(short.length, 2)
  const big = await checkRagMedia("/run", { probe: probes(50), size: async () => 12_000_001 })
  assert.equal(big.length, 2)
  assert.equal(RAG_CLIP.name, "rag-loop")
})
