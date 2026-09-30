// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LastMile } from "./checklist/LastMile"
import {
  HANG_MAX,
  HANG_STEP,
  hangFor,
  hangForHtml,
  keepContinuation,
  withPathBreaks,
} from "./code-hang"
import { DeveloperHome } from "./DeveloperHome"
import { Guardrails } from "./gates/Guardrails"
import { prepareGates } from "./gates/prepare"
import { SchemaPlayground } from "./playground/SchemaPlayground"
import { prepareRouteShapes } from "./shapes/prepare"
import { RouteShapes } from "./shapes/RouteShapes"
import { DeployTargets } from "./ship/DeployTargets"
import { prepareDeployTargets } from "./ship/prepare"
import { deployTargets } from "./ship/ship-data"
import { TestReplay } from "./ship/TestReplay"
import { FolderTour } from "./tour/FolderTour"
import { prepareFolderTour } from "./tour/prepare"

const render = (node: React.ReactNode) => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(node)
  return container
}

/** The one element in `root` whose data-hang line reads `text`, and its hang. */
function hangOf(root: Element, text: string) {
  const matches = [...root.querySelectorAll("[data-hang]")].filter(
    (node) => node.textContent === text,
  )
  expect(matches.length, text).toBeGreaterThan(0)
  const hangs = new Set(matches.map((node) => node.getAttribute("data-hang")))
  expect(hangs.size, text).toBe(1)
  return [...hangs][0]
}

/** Nothing hangs on a gutter, a prompt or a line wrapper that holds one. */
function expectNoHangAroundGutters(root: Element) {
  for (const node of root.querySelectorAll('[data-hang] [aria-hidden="true"]')) {
    throw new Error(`A hang holds a gutter: ${node.parentElement?.outerHTML}`)
  }
  // The hang is a class-free attribute ui.css reads: no inline style in a pane.
  expect(root.querySelector("pre[style], pre [style]")).toBeNull()
}

describe("hangFor", () => {
  it.each([
    ["x", 4],
    ["  x", 6],
    ["      x", 10],
    ["\tx", 6],
    ["", 4],
    [" ".repeat(40), HANG_MAX],
  ])("%j hangs %i", (text, hang) => {
    expect(hangFor(text)).toBe(hang)
  })

  it("reads the indentation through highlightCode's spans", () => {
    expect(hangForHtml('<span class="a">    </span><span class="b">x</span>')).toBe(8)
    expect(hangForHtml('<span class="a">&lt;x</span>')).toBe(HANG_STEP)
    // Spaces inside a tag (its attributes) aren't indentation.
    expect(hangForHtml('<span class="a b c" style="x: y">  z</span>')).toBe(6)
    expect(hangForHtml("<span>\tz</span>")).toBe(6)
  })
})

describe("keepContinuation", () => {
  it("joins a trailing backslash to the word before it", () => {
    expect(keepContinuation("  --namespace b4-app \\")).toBe("  --namespace b4-app \\")
  })
  it("leaves every other line alone", () => {
    expect(keepContinuation("  --set image.tag=2026-08-10")).toBe("  --set image.tag=2026-08-10")
    expect(keepContinuation("echo a\\b")).toBe("echo a\\b")
  })
})

describe("each code pane hangs its lines on the text, not the gutter", () => {
  it("the tour's CodePanel", async () => {
    const tour = render(<FolderTour {...(await prepareFolderTour())} />)
    const eval_ = tour.querySelector("article#tour-eval pre")
    if (!eval_) throw new Error("No eval panel")
    expect(hangOf(eval_, '      name: "ada",')).toBe("10")
    const greet = tour.querySelector("article#tour-greet pre")
    if (!greet) throw new Error("No tool panel")
    expect(hangOf(greet, "export default async (input: { readonly name: string }) => {")).toBe("4")
    // Every rendered line's text carries a hang; the line number does not.
    for (const line of tour.querySelectorAll("pre code > span")) {
      const [number, text] = [...line.children]
      if (!text) continue
      expect(number?.hasAttribute("data-hang")).toBe(false)
      expect(text.hasAttribute("data-hang"), line.textContent ?? "").toBe(true)
    }
    expectNoHangAroundGutters(tour)
  })

  it("the playground's source and schema", async () => {
    const { variants } = await prepareFolderTour()
    const playground = render(<SchemaPlayground variants={variants} />)
    const [source, schema] = [...playground.querySelectorAll("section")]
    if (!source || !schema) throw new Error("No panes")
    expect(hangOf(source, "export default async (input: { readonly name: string }) => {")).toBe("4")
    const deep = variants[0]?.schemaText.find((line) => /^ {6}\S/.test(line))
    if (!deep) throw new Error("The schema has a 6-space line")
    expect(hangOf(schema, deep)).toBe("10")
    // The schema's +/space gutter is its own column, outside the hung text.
    const gutters = schema.querySelectorAll('[aria-hidden="true"]:not(pre)')
    expect(gutters.length).toBeGreaterThan(0)
    for (const gutter of gutters) {
      expect(gutter.hasAttribute("data-hang")).toBe(false)
      expect(gutter.nextElementSibling?.hasAttribute("data-hang")).toBe(true)
    }
    expectNoHangAroundGutters(playground)
  })

  it("the guardrails config files", async () => {
    const gates = render(<Guardrails {...(await prepareGates())} />)
    expect(hangOf(gates, '    network: { mode: "deny" },')).toBe("8")
    expectNoHangAroundGutters(gates)
  })

  it("the route shapes", async () => {
    const shapes = render(<RouteShapes code={await prepareRouteShapes()} />)
    expect(hangOf(shapes, '  model: "gpt-5-mini",')).toBe("6")
    expectNoHangAroundGutters(shapes)
  })

  it("the test replay's commands and log", () => {
    const replay = render(<TestReplay />)
    expect(hangOf(replay, "npm test -- --reporter=verbose")).toBe("4")
    expect(hangOf(replay, "      Tests  1 passed (1)")).toBe("10")
    expectNoHangAroundGutters(replay)
  })

  it("the deploy targets' config, commands and output", async () => {
    const targets = render(<DeployTargets code={await prepareDeployTargets()} />)
    const k8s = targets.querySelector('[data-target="kubernetes"]')
    if (!k8s) throw new Error("No kubernetes target")
    expect(hangOf(k8s, "helm install b4-app oci://ghcr.io/cacheplane/charts/b4-app \\")).toBe("4")
    expect(hangOf(k8s, "  --namespace b4-app \\")).toBe("6")
    expect(hangOf(k8s, "  --set image.tag=2026-08-10")).toBe("6")
    expectNoHangAroundGutters(targets)
  })

  it("the checklist's excerpts, one hung line each", () => {
    const checklist = render(<LastMile />)
    const memory = checklist.querySelector('[data-item="memory"] pre')
    if (!memory) throw new Error("No memory excerpt")
    expect(hangOf(memory, "export default defineMemory({")).toBe("4")
    expect(hangOf(memory, '  kind: "semantic",')).toBe("6")
    expectNoHangAroundGutters(checklist)
  })
})

it("shows a trailing backslash with a no-break space, and keeps the command text as written", () => {
  const helm = deployTargets.find((target) => target.id === "kubernetes")?.after.at(-1)
  expect(helm).toContain("b4-app \\\n")
  expect(helm).not.toContain(" ")
})

it("ui.css hangs every value the homepage renders, with no inline style in any pane", async () => {
  const home = render(await DeveloperHome())
  const used = new Set(
    [...home.querySelectorAll("[data-hang]")].map((node) => node.getAttribute("data-hang")),
  )
  expect(used.size).toBeGreaterThan(1)
  expect(home.querySelector("pre[style], pre [style]")).toBeNull()
  const css = readFileSync(resolve(__dirname, "../../styles/ui.css"), "utf8")
  const layered = css.slice(css.indexOf("@layer components {"))
  for (let n = HANG_STEP; n <= HANG_MAX; n += 1) {
    const rule = new RegExp(
      `\\[data-hang="${n}"\\] \\{\\s*padding-left: ${n}ch;\\s*text-indent: -${n}ch;\\s*\\}`,
    )
    expect(layered, `data-hang=${n}`).toMatch(rule)
  }
  for (const n of used) expect(Number(n)).toBeLessThanOrEqual(HANG_MAX)
})

describe("withPathBreaks", () => {
  // A registry URL longer than a phone line used to split mid-word
  // (`charts/b` / `4-app`). A <wbr> after each slash lets it break at a path
  // segment instead, and leaves the text a visitor selects or copies unchanged.
  it("adds a break opportunity after each slash, and nothing else", () => {
    const line = "helm install b4-app oci://ghcr.io/cacheplane/charts/b4-app \\"
    const html = renderToString(<code>{withPathBreaks(line)}</code>)
    expect(html).toContain("charts/<wbr/>b4-app")
    expect(html.match(/<wbr\/>/g)).toHaveLength(line.split("/").length - 1)
    const node = document.createElement("div")
    node.innerHTML = html
    expect(node.textContent).toBe(line)
  })

  it("leaves a line without slashes as plain text", () => {
    expect(renderToString(<code>{withPathBreaks("npx b4 build")}</code>)).toBe(
      "<code>npx b4 build</code>",
    )
  })

  it("breaks the kubernetes tab's registry URL at a slash", async () => {
    const html = renderToString(<DeployTargets code={await prepareDeployTargets()} />)
    expect(html).toContain("charts/<wbr/>b4-app")
  })
})
