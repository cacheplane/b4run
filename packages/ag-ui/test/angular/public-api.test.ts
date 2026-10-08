import { readdirSync, readFileSync } from "node:fs"
import { reflectComponentType } from "@angular/core"
import { describe, expect, test } from "vitest"
import * as copilotkit from "../../src/angular/copilotkit/index.js"
import * as events from "../../src/angular/events/index.js"
import * as kit from "../../src/angular/index.js"

describe("@b4run/ag-ui/angular public API", () => {
  test("exports the activity kit, the blocks and the signal helpers", () => {
    expect(Object.keys(kit).sort()).toEqual(
      [
        "ApprovalCardComponent",
        "ChecklistComponent",
        "DisclosureComponent",
        "PlanStepComponent",
        "ReasoningStepComponent",
        "SourceChipsComponent",
        "StepComponent",
        "StepDetailComponent",
        "StepGroupComponent",
        "StepIconComponent",
        "SubagentStepComponent",
        "SvgAttrsDirective",
        "TurnActivityComponent",
        "disclosure",
        "elapsedSignal",
        "liveSignal",
      ].sort(),
    )
  })

  test("components are standalone, with the selectors the README documents", () => {
    const mirrors = Object.entries(kit).flatMap(([name, value]) => {
      const mirror = typeof value === "function" ? reflectComponentType(value as never) : null
      return mirror ? [[name, mirror] as const] : []
    })
    for (const [name, mirror] of mirrors) expect(mirror.isStandalone, name).toBe(true)
    const selectors = Object.fromEntries(mirrors.map(([name, mirror]) => [name, mirror.selector]))
    expect(selectors).toEqual({
      ApprovalCardComponent: "b4-approval-card",
      ChecklistComponent: "b4-checklist",
      DisclosureComponent: "b4-disclosure",
      PlanStepComponent: "li[b4-plan-step]",
      ReasoningStepComponent: "li[b4-reasoning-step]",
      SourceChipsComponent: "b4-source-chips",
      StepComponent: "li[b4-step]",
      StepDetailComponent: "b4-step-detail",
      StepGroupComponent: "li[b4-step-group]",
      StepIconComponent: "b4-step-icon",
      SubagentStepComponent: "li[b4-subagent-step]",
      TurnActivityComponent: "b4-turn-activity",
    })
  })

  test("imports nothing from React or CopilotKit, and every helper comes from @b4run/ag-ui/view", () => {
    const dir = `${import.meta.dirname}/../../src/angular/lib`
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, "utf8")
      expect(source, file).not.toMatch(/from "react"|@copilotkit|@b4run\/ag-ui\/react/)
      for (const [, specifier] of source.matchAll(/from "(@b4run\/[^"]+)"/g)) {
        expect(["@b4run/ag-ui", "@b4run/ag-ui/view"], file).toContain(specifier)
      }
    }
  })
})

/** Every import specifier of an entry point's sources that is not relative. */
function bareImports(dir: string): Map<string, string[]> {
  const root = `${import.meta.dirname}/../../src/angular/${dir}`
  const found = new Map<string, string[]>()
  for (const file of readdirSync(root)) {
    const source = readFileSync(`${root}/${file}`, "utf8")
    found.set(
      file,
      [...source.matchAll(/from "([^".][^"]*)"/g)].map((m) => m[1] ?? ""),
    )
  }
  return found
}

describe("@b4run/ag-ui/angular/events public API", () => {
  test("exports the turns store and the two connector components", () => {
    expect(Object.keys(events).sort()).toEqual(
      [
        "ApprovalsComponent",
        "B4TurnsStore",
        "MessageActivityComponent",
        "createB4Turns",
        "provideB4Turns",
      ].sort(),
    )
    expect(reflectComponentType(events.MessageActivityComponent)?.selector).toBe(
      "b4-message-activity",
    )
    expect(reflectComponentType(events.ApprovalsComponent)?.selector).toBe("b4-approvals")
  })

  test("depends on no chat framework: Angular, the kit and the view core only", () => {
    for (const [file, specifiers] of bareImports("events")) {
      for (const specifier of specifiers) {
        expect(["@angular/core", "@b4run/ag-ui/view"], file).toContain(specifier)
      }
    }
  })
})

describe("@b4run/ag-ui/angular/copilotkit public API", () => {
  test("exports the provider, its store and the two chat components", () => {
    expect(Object.keys(copilotkit).sort()).toEqual(
      [
        "B4ActivityApprovalsComponent",
        "B4ActivityAssistantMessageComponent",
        "B4ActivityStore",
        "provideB4Activity",
      ].sort(),
    )
    expect(reflectComponentType(copilotkit.B4ActivityAssistantMessageComponent)?.selector).toBe(
      "b4-activity-assistant-message",
    )
    expect(reflectComponentType(copilotkit.B4ActivityApprovalsComponent)?.selector).toBe(
      "b4-activity-approvals",
    )
  })

  test("is the only entry that imports CopilotKit, and imports it from the package root", () => {
    for (const [file, specifiers] of bareImports("copilotkit")) {
      for (const specifier of specifiers) {
        expect(["@angular/core", "@b4run/ag-ui/view", "@copilotkit/angular"], file).toContain(
          specifier,
        )
      }
    }
  })

  test("package.json exports each entry from ngc's output, Angular and CopilotKit optional peers", () => {
    const pkg = JSON.parse(readFileSync(`${import.meta.dirname}/../../package.json`, "utf8")) as {
      exports: Record<string, unknown>
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional?: boolean }>
    }
    for (const [subpath, dir] of [
      ["./angular", "angular"],
      ["./angular/events", "angular/events"],
      ["./angular/copilotkit", "angular/copilotkit"],
    ] as const) {
      expect(pkg.exports[subpath]).toEqual({
        types: `./dist/${dir}/index.d.ts`,
        default: `./dist/${dir}/index.js`,
      })
    }
    expect(pkg.peerDependencies["@copilotkit/angular"]).toBe(">=0.5.3")
    for (const peer of [
      "@angular/common",
      "@angular/core",
      "@angular/platform-browser",
      "@copilotkit/angular",
    ]) {
      expect(pkg.peerDependenciesMeta[peer]?.optional, peer).toBe(true)
    }
  })
})

describe("the Angular sources inside @b4run/ag-ui", () => {
  /** Every `.ts` file under `src/angular`, relative to it. */
  const files = (dir = ""): string[] =>
    readdirSync(`${import.meta.dirname}/../../src/angular/${dir}`, { withFileTypes: true }).flatMap(
      (entry) =>
        entry.isDirectory()
          ? files(`${dir}${entry.name}/`)
          : entry.name.endsWith(".ts")
            ? [`${dir}${entry.name}`]
            : [],
    )

  test("relative imports stay inside src/angular, so ngc compiles only the Angular entries", () => {
    for (const file of files()) {
      const source = readFileSync(`${import.meta.dirname}/../../src/angular/${file}`, "utf8")
      for (const [, specifier = ""] of source.matchAll(/from "(\.[^"]*)"/g)) {
        const depth = file.split("/").length - 1
        const ups = specifier.match(/\.\.\//g)?.length ?? 0
        expect(ups, `${file}: ${specifier}`).toBeLessThanOrEqual(depth)
        expect(specifier, file).toMatch(/\.js$/)
      }
    }
  })

  test("the core is imported by package name, the way the built package resolves it", () => {
    for (const file of files()) {
      const source = readFileSync(`${import.meta.dirname}/../../src/angular/${file}`, "utf8")
      for (const [, specifier = ""] of source.matchAll(/from "(@b4run\/[^"]+)"/g)) {
        expect(["@b4run/ag-ui", "@b4run/ag-ui/view"], file).toContain(specifier)
      }
    }
  })
})
