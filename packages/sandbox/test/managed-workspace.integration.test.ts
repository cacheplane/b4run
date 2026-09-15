import { randomUUID } from "node:crypto"
import { createSourceBundle, createWorkspaceIntent } from "@b4run/workspace/node"
import { describe, expect, it } from "vitest"
import { createDocker } from "../src/docker/docker-cli.ts"
import { createDockerManagedWorkspaces } from "../src/docker/managed-workspace.ts"

describe.skipIf(process.env.B4_TEST_DOCKER !== "1")(
  "managed Docker qualification",
  { timeout: 120000 },
  () => {
    it("preserves exact source and edits across replacement; stale release is safe", async () => {
      const docker = createDocker(),
        signal = new AbortController().signal
      const opts = {
        scope: `managed-test-${randomUUID()}`,
        image: process.env.B4_TEST_MANAGED_IMAGE ?? "b4-code-fixer:fixture-v1",
        docker,
      }
      const provider = createDockerManagedWorkspaces(opts)
      const source = createSourceBundle([
        { path: "binary", bytes: new Uint8Array([0, 255, 10, 128]), executable: false },
        { path: "-script", bytes: Buffer.from("#!/bin/sh\nprintf exact"), executable: true },
      ])
      const intent = createWorkspaceIntent({
        operationId: randomUUID(),
        installationId: randomUUID(),
        threadId: "test",
        definition: {
          version: 1,
          source,
          environmentLinks: [
            { path: "node_modules", target: "/opt/fixtures/cli-flags/node_modules" },
          ],
          baseline: "git",
        },
        environment: await provider.resolveEnvironment(signal),
      })
      try {
        const ready = await provider.create(intent, source, signal)
        const a = await provider.reconnect(ready, { network: { mode: "deny" } }, signal)
        const ids = await docker.run([
          "ps",
          "-q",
          "--filter",
          `label=b4.workspace.incarnation=${a.reference.incarnation}`,
        ])
        const checked = await docker.exec(ids.stdout.trim(), [
          "node",
          "-e",
          "const fs=require('fs');console.log(JSON.stringify({bytes:[...fs.readFileSync('/workspace/binary')],mode:fs.statSync('/workspace/-script').mode&511,link:fs.readlinkSync('/workspace/node_modules')}));fs.writeFileSync('/workspace/edit','kept')",
        ])
        expect(checked.exitCode, checked.stderr).toBe(0)
        expect(JSON.parse(checked.stdout)).toEqual({
          bytes: [0, 255, 10, 128],
          mode: 493,
          link: "/opt/fixtures/cli-flags/node_modules",
        })
        const restarted = createDockerManagedWorkspaces(opts)
        const b = await restarted.reconnect(ready, { network: { mode: "deny" } }, signal)
        await restarted.release(a.reference, signal)
        const id = await docker.run([
          "ps",
          "-q",
          "--filter",
          `label=b4.workspace.incarnation=${b.reference.incarnation}`,
        ])
        expect((await docker.exec(id.stdout.trim(), ["cat", "/workspace/edit"])).stdout).toBe(
          "kept",
        )
        expect(await restarted.inspectCreation(intent, signal)).toEqual({
          status: "ready",
          workspace: ready,
        })
      } finally {
        await provider.destroy({ intent }, signal)
      }
    })
  },
)

describe.skipIf(process.env.B4_TEST_DOCKER !== "1")(
  "managed Docker interruption qualification",
  { timeout: 120000 },
  () => {
    it("recovers surviving preparer, lost publication acknowledgement, and interrupted deletion", async () => {
      const real = createDocker(),
        signal = new AbortController().signal
      let preparationLost = true,
        publicationLost = true,
        deletionFailed = false
      const docker = {
        run: async (args: readonly string[], options?: { readonly signal?: AbortSignal }) => {
          if (deletionFailed && args[0] === "volume" && args[1] === "rm") {
            deletionFailed = false
            return { exitCode: 1, stdout: "", stderr: "injected daemon disconnect" }
          }
          const result = await real.run(args, options)
          if (publicationLost && args[0] === "create" && result.exitCode === 0) {
            publicationLost = false
            throw Error("lost publication reply")
          }
          return result
        },
        exec: async (
          container: string,
          command: readonly string[],
          options?: { readonly stdin?: string; readonly signal?: AbortSignal },
        ) => {
          const result = await real.exec(container, command, options)
          if (preparationLost && result.exitCode === 0) {
            preparationLost = false
            throw Error("runtime died while preparer remains live")
          }
          return result
        },
      }
      const opts = {
        scope: `interrupt-${randomUUID()}`,
        image: process.env.B4_TEST_MANAGED_IMAGE ?? "b4-code-fixer:fixture-v1",
        docker,
      }
      const provider = createDockerManagedWorkspaces(opts)
      const source = createSourceBundle([
        { path: "source", bytes: Buffer.from("original"), executable: false },
      ])
      const intent = createWorkspaceIntent({
        operationId: randomUUID(),
        installationId: randomUUID(),
        threadId: "interrupt",
        definition: { version: 1, source, environmentLinks: [] },
        environment: await provider.resolveEnvironment(signal),
      })
      try {
        await expect(provider.create(intent, source, signal)).rejects.toMatchObject({
          code: "uncertain",
        })
        expect(await provider.inspectCreation(intent, signal)).toEqual({ status: "pending" })
        const fresh = createDockerManagedWorkspaces(opts)
        const ready = await fresh.create(intent, source, signal)
        expect((await fresh.inspectCreation(intent, signal)).status).toBe("ready")
        const session = await fresh.reconnect(ready, { network: { mode: "deny" } }, signal)
        const controller = new AbortController()
        const execution = session.handle.exec.runCommand(
          { command: "touch /workspace/started; sleep 100; touch /workspace/late" },
          { signal: controller.signal, workspaceRoot: "/workspace" },
        )
        const settled = execution.catch((error) => error)
        const id = (
          await real.run([
            "ps",
            "-q",
            "--filter",
            `label=b4.workspace.incarnation=${session.reference.incarnation}`,
          ])
        ).stdout.trim()
        for (let i = 0; i < 100; i++) {
          if ((await real.exec(id, ["test", "-f", "/workspace/started"])).exitCode === 0) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        controller.abort()
        expect(await settled).toBeInstanceOf(Error)
        expect((await real.run(["container", "inspect", id])).exitCode).not.toBe(0)
        deletionFailed = true
        await expect(fresh.destroy({ intent }, signal)).rejects.toMatchObject({ code: "uncertain" })
        expect(
          (await real.run(["container", "inspect", ready.reference.resource.record ?? ""]))
            .exitCode,
        ).toBe(0)
        await fresh.destroy({ intent }, signal)
        expect(await fresh.inspectCreation(intent, signal)).toEqual({ status: "absent" })
      } finally {
        await provider.destroy({ intent }, signal)
      }
    })
  },
)
