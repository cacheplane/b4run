import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createAgentsMdMarker } from "../../src/capabilities/built-in/agents-md.js"
import type { CapabilityMarkerContext } from "../../src/capabilities/types.js"
import { nodeMarkerFs } from "../../src/node-marker-fs.js"

describe("createAgentsMdMarker", () => {
  let routeDir: string
  let workDir: string
  let originalCwd: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "b4-agents-md-"))
    routeDir = join(workDir, "route")
    mkdirSync(routeDir, { recursive: true })
    originalCwd = process.cwd()
    // NOTE: process.chdir kept for test isolation, but the marker now uses
    // context.appRoot (workDir) rather than process.cwd() to resolve AGENTS.md.
    process.chdir(workDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workDir, { recursive: true, force: true })
  })

  function makeCtx(
    appRoot: string,
    agentsMd?: CapabilityMarkerContext["agentsMd"],
  ): CapabilityMarkerContext {
    return {
      routeManifest: { appRoot, routes: [] },
      descriptor: undefined,
      appRoot,
      markerFs: nodeMarkerFs,
      ...(agentsMd !== undefined ? { agentsMd } : {}),
    }
  }

  function writeAgentsMd(content: string): void {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), content)
  }

  it("always detects (returns true)", async () => {
    const marker = createAgentsMdMarker()
    expect(await marker.detect(routeDir, makeCtx(workDir))).toBe(true)
  })

  it("load returns a single promptFragment, no tools/state/transformers", async () => {
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir, makeCtx(workDir))
    expect(contribution.promptFragment?.placement).toBe("after_user_prompt")
    expect(contribution.tools).toBeUndefined()
    expect(contribution.stateFields).toBeUndefined()
    expect(contribution.streamTransformers).toBeUndefined()
  })

  it("renders empty string when workspace/AGENTS.md does not exist", async () => {
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir, makeCtx(workDir))
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("renders content under '# Memory' heading when file exists", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "Remember the pnpm convention.")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir, makeCtx(workDir))
    const out = contribution.promptFragment?.render({}) ?? ""
    expect(out).toContain("# Memory")
    expect(out).toContain("Remember the pnpm convention.")
  })

  it("returns empty string when file is whitespace-only", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), "   \n\n  \n")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir, makeCtx(workDir))
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("returns size-notice (not body) when file exceeds 64 KiB", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const big = "x".repeat(65 * 1024)
    writeFileSync(join(workDir, "workspace", "AGENTS.md"), big)
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir, makeCtx(workDir))
    const out = contribution.promptFragment?.render({}) ?? ""
    expect(out).toContain("# Memory")
    expect(out).toContain("exceeds 64 KiB")
    expect(out).not.toContain("xxxxxxxxxxx") // body NOT included
  })

  it("returns empty string when AGENTS.md is a directory (read throws)", async () => {
    mkdirSync(join(workDir, "workspace", "AGENTS.md"), { recursive: true })
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir, makeCtx(workDir))
    expect(contribution.promptFragment?.render({})).toBe("")
  })

  it("re-reads the file on each render call", async () => {
    mkdirSync(join(workDir, "workspace"), { recursive: true })
    const path = join(workDir, "workspace", "AGENTS.md")
    writeFileSync(path, "first")
    const marker = createAgentsMdMarker()
    const contribution = await marker.load(routeDir, makeCtx(workDir))
    const first = contribution.promptFragment?.render({}) ?? ""
    expect(first).toContain("first")
    writeFileSync(path, "second")
    const second = contribution.promptFragment?.render({}) ?? ""
    expect(second).toContain("second")
    expect(second).not.toContain("first")
  })

  describe("agentsMd.writable", () => {
    const writeInstruction = 'writeFile({ path: "AGENTS.md"'

    it("tells the model to update the file by default (no agentsMd on the context)", async () => {
      writeAgentsMd("House style: metric units.")
      const contribution = await createAgentsMdMarker().load(routeDir, makeCtx(workDir))
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).toContain("# Memory")
      expect(out).toContain(writeInstruction)
      expect(out).toContain("House style: metric units.")
    })

    it("keeps the memory header when writable is true", async () => {
      writeAgentsMd("House style: metric units.")
      const contribution = await createAgentsMdMarker().load(
        routeDir,
        makeCtx(workDir, { writable: true }),
      )
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).toContain("# Memory")
      expect(out).toContain(writeInstruction)
    })

    it("renders read-only guidance with no write instruction when writable is false", async () => {
      writeAgentsMd("House style: metric units.")
      const contribution = await createAgentsMdMarker().load(
        routeDir,
        makeCtx(workDir, { writable: false }),
      )
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).toContain("# Project guidance")
      expect(out).toContain("read-only")
      expect(out).toContain("do NOT re-read this file with any tool")
      expect(out).toContain("Do NOT modify `AGENTS.md`")
      expect(out).not.toContain("# Memory")
      expect(out).not.toContain("writeFile")
      expect(out).toContain("House style: metric units.")
    })

    it("uses the read-only header for the over-64 KiB notice too", async () => {
      writeAgentsMd("x".repeat(65 * 1024))
      const contribution = await createAgentsMdMarker().load(
        routeDir,
        makeCtx(workDir, { writable: false }),
      )
      const out = contribution.promptFragment?.render({}) ?? ""
      expect(out).toContain("# Project guidance")
      expect(out).toContain("exceeds 64 KiB")
      expect(out).not.toContain("writeFile")
      expect(out).not.toContain("xxxxxxxxxxx")
    })

    it("still renders empty when the file is absent", async () => {
      const contribution = await createAgentsMdMarker().load(
        routeDir,
        makeCtx(workDir, { writable: false }),
      )
      expect(contribution.promptFragment?.render({})).toBe("")
    })
  })
})
