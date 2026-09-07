import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createArtifactRoot, createGeneratedApp } from "../src/testing/index.ts"

describe("generated app helper", () => {
  it("materializes the basic template in an isolated temp root with default specifiers", async () => {
    const baseDir = await mkdtemp(resolve(tmpdir(), "b4-devkit-generated-app-"))

    try {
      const artifactRoot = await createArtifactRoot({
        baseDir,
        lane: "generated",
        runId: "run-generated-app-test",
      })

      const generatedApp = await createGeneratedApp({
        appName: "sample-generated-app",
        artifactRoot,
        template: "basic",
      })

      const packageJson = await readFile(resolve(generatedApp.appRoot, "package.json"), "utf8")

      expect(generatedApp.appRoot).toBe(resolve(artifactRoot, "app"))
      expect(generatedApp.artifactRoot).toBe(artifactRoot)
      expect(generatedApp.template).toBe("basic")
      expect(generatedApp.transcriptPath).toBe(
        resolve(artifactRoot, "transcripts", "generated-app.log"),
      )
      expect(packageJson).toContain('"name": "sample-generated-app"')
      expect(packageJson).toContain('"@b4run/cli": "workspace:*"')
      expect(packageJson).toContain('"@b4run/langchain": "workspace:*"')
      expect(packageJson).toContain('"@b4run/sdk": "workspace:*"')
      expect(packageJson).toContain('"@b4run/config-typescript": "workspace:*"')
      expect(packageJson).toContain('"@b4run/testing": "workspace:*"')
      expect(packageJson).toContain('"@b4run/evals": "workspace:*"')
      expect(packageJson).toContain('"@b4run/inspector": "workspace:*"')
      expect(packageJson).toContain('"test": "vitest run"')
      expect(packageJson).toContain('"eval": "b4 eval"')
      await expect(
        access(resolve(generatedApp.appRoot, "test/agent.test.ts"), constants.F_OK),
      ).resolves.toBeUndefined()
      await expect(
        access(
          resolve(generatedApp.appRoot, "src/app/(public)/hello/[tenant]/evals/smoke.eval.ts"),
          constants.F_OK,
        ),
      ).resolves.toBeUndefined()
    } finally {
      await rm(baseDir, { force: true, recursive: true })
    }
  })

  it("materializes the research template with sandbox-ready shared tools and memory scripts", async () => {
    const baseDir = await mkdtemp(resolve(tmpdir(), "b4-devkit-generated-research-app-"))

    try {
      const artifactRoot = await createArtifactRoot({
        baseDir,
        lane: "generated",
        runId: "run-generated-research-app-test",
      })

      const generatedApp = await createGeneratedApp({
        appName: "sample-research-app",
        artifactRoot,
        template: "research",
      })

      // The research template is a two-package npm workspace. Only the
      // orchestrator manifest, the pnpm config, the tour README, and the
      // ignore file stay at the app root; the B4.run app lives in `server/`.
      const rootPackageJson = await readFile(resolve(generatedApp.appRoot, "package.json"), "utf8")
      const rootManifest = JSON.parse(rootPackageJson) as {
        scripts: Record<string, string>
        workspaces: readonly string[]
      }
      const serverPackageJson = await readFile(
        resolve(generatedApp.appRoot, "server/package.json"),
        "utf8",
      )
      const serverManifest = JSON.parse(serverPackageJson) as {
        scripts: Record<string, string>
      }
      const webPackageJson = await readFile(
        resolve(generatedApp.appRoot, "web/package.json"),
        "utf8",
      )
      const pnpmWorkspace = await readFile(
        resolve(generatedApp.appRoot, "pnpm-workspace.yaml"),
        "utf8",
      )
      const readDoc = await readFile(
        resolve(generatedApp.appRoot, "server/src/tools/readDoc.ts"),
        "utf8",
      )
      const searchCorpus = await readFile(
        resolve(generatedApp.appRoot, "server/src/tools/searchCorpus.ts"),
        "utf8",
      )
      const prompt = await readFile(
        resolve(generatedApp.appRoot, "server/src/app/research/index.ts"),
        "utf8",
      )
      const generatedTypes = await readFile(
        resolve(generatedApp.appRoot, "server/.b4/b4.generated.d.ts"),
        "utf8",
      )
      const rootReadme = await readFile(resolve(generatedApp.appRoot, "README.md"), "utf8")
      const readme = await readFile(resolve(generatedApp.appRoot, "server/README.md"), "utf8")
      const researchTest = await readFile(
        resolve(generatedApp.appRoot, "server/test/research.test.ts"),
        "utf8",
      )
      const sandboxTest = await readFile(
        resolve(generatedApp.appRoot, "server/test/sandbox-docker.test.ts"),
        "utf8",
      )
      const envExample = await readFile(
        resolve(generatedApp.appRoot, "server/.env.example"),
        "utf8",
      )
      const gitignore = await readFile(resolve(generatedApp.appRoot, ".gitignore"), "utf8")

      expect(serverPackageJson).toContain('"@b4run/sandbox": "workspace:*"')
      expect(rootManifest.workspaces).toEqual(["server", "web"])
      // Each single-workspace delegator keeps its literal trailing ` --`; see
      // `template-root-scripts.test.ts` for why deleting it breaks the harness.
      expect(rootManifest.scripts).toEqual({
        dev: "npm run dev --workspace server --",
        "dev:server": "npm run dev --workspace server --",
        "dev:web": "npm run dev --workspace web --",
        verify: "npm run verify --workspace server --",
        typegen: "npm run typegen --workspace server --",
        check: "npm run check --workspace server --",
        typecheck: "npm run typecheck --workspaces --if-present",
        test: "npm run test --workspaces --if-present",
        eval: "npm run eval --workspace server --",
        build: "npm run build --workspaces --if-present",
        start: "npm start --workspace server --",
        "memory:list": "npm run memory:list --workspace server --",
        "memory:approve": "npm run memory:approve --workspace server --",
      })
      expect(serverManifest.scripts).toEqual({
        dev: "b4 dev --port 3002",
        verify: "b4 verify",
        typegen: "b4 typegen",
        check: "b4 check",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        eval: "b4 eval",
        build: "b4 build",
        start: "node --env-file-if-exists=.env .b4/build/server.mjs",
        "test:sandbox:docker": "B4_DEMO_DOCKER_SANDBOX=1 vitest run test/sandbox-docker.test.ts",
        "memory:list": "b4 memory list",
        "memory:approve": "b4 memory approve",
      })
      expect(rootPackageJson).not.toContain('"pnpm"')
      expect(serverPackageJson).not.toContain('"pnpm"')
      expect(rootReadme).toContain("npm run dev:web")
      // `writeTemplate` copies an unrecognized `{{token}}` through verbatim, so
      // a specifier missing from this helper's map ships the literal token into
      // the generated manifest instead of failing.
      expect(webPackageJson).toContain('"@b4run/ag-ui": "workspace:*"')
      expect(webPackageJson).not.toContain("{{")
      expect(pnpmWorkspace).toContain("allowBuilds:")
      expect(pnpmWorkspace).toContain("esbuild: true")
      expect(readDoc).toContain("ctx.fs.readFile")
      expect(searchCorpus).toContain("ctx.fs.listDir")
      expect(prompt).toContain("recall({ query:")
      expect(prompt).toContain("remember({")
      expect(prompt).toContain("recursionLimit: 100")
      expect(envExample).toContain("OPENAI_API_KEY=")
      expect(gitignore).toContain(".env\n.env.*\n!.env.example\n")
      expect(generatedTypes).toContain("readonly task:")
      expect(generatedTypes).toContain("readonly recall:")
      expect(generatedTypes).toContain("readonly remember:")
      expect(readme).toContain("Docker sandbox")
      expect(readme).toContain("b4 memory approve")
      expect(researchTest).toContain("seedMemory")
      expect(researchTest).toContain(`const resumed = await h.resume({
    resume: run.interrupts.map((entry) => ({
      interruptId: entry.interruptId,
      status: "resolved" as const,
      payload: "once",
    })),
  })`)
      expect(sandboxTest).toContain("B4_DEMO_DOCKER_SANDBOX")
      expect(sandboxTest).toContain("dockerSandbox")
      // The corpus tools are shared at `server/src/tools/`, never route-local.
      await expect(
        access(
          resolve(generatedApp.appRoot, "server/src/app/research/tools/readDoc.ts"),
          constants.F_OK,
        ),
      ).rejects.toThrow()
      // The template ships `.env.example` only — never a real `.env`, at either
      // level of the workspace.
      await expect(access(resolve(generatedApp.appRoot, ".env"), constants.F_OK)).rejects.toThrow()
      await expect(
        access(resolve(generatedApp.appRoot, "server/.env"), constants.F_OK),
      ).rejects.toThrow()
    } finally {
      await rm(baseDir, { force: true, recursive: true })
    }
  })
})
