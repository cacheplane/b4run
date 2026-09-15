import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerFilesystem } from "../src/docker/docker-filesystem.ts"
import type { KubeClient } from "../src/kubernetes/kube-client.ts"
import { kubeFilesystem } from "../src/kubernetes/kube-filesystem.ts"

const exec = promisify(execFile)
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
for (const provider of ["docker", "kube"] as const) {
  describe(`${provider} bounded reads`, () => {
    function setup() {
      const root = mkdtempSync(join(tmpdir(), "b4-read-cap-"))
      roots.push(root)
      const outputSizes: number[] = []
      const run = async (argv: string[]) => {
        try {
          const result = await exec(argv[0] as string, argv.slice(1))
          outputSizes.push(Buffer.byteLength(result.stdout))
          return { ...result, exitCode: 0 }
        } catch (error) {
          const e = error as { stdout: string; stderr: string; code: number }
          outputSizes.push(Buffer.byteLength(e.stdout))
          return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code }
        }
      }
      const fs =
        provider === "docker"
          ? dockerFilesystem(
              { exec: (_container: string, argv: string[]) => run(argv) } as unknown as Docker,
              "container",
            )
          : kubeFilesystem(
              {
                exec: (_ns: string, _pod: string, argv: string[]) => run(argv),
              } as unknown as KubeClient,
              "ns",
              "pod",
            )
      return {
        root,
        outputSizes,
        fs,
        ctx: { workspaceRoot: root, signal: new AbortController().signal },
      }
    }
    for (const operation of ["readFile", "readBinaryFile"] as const) {
      it(`${operation} caps transport before decoding and preserves read failures`, async () => {
        const { root, outputSizes, fs, ctx } = setup()
        const path = join(root, "quote'file")
        writeFileSync(path, Buffer.alloc(100_000, 97))
        await expect(fs[operation]?.(path, ctx, { maxBytes: 8 })).rejects.toThrow(/maxBytes/)
        expect(outputSizes[0]).toBeLessThan(256)
        await expect(fs[operation]?.(join(root, "absent"), ctx, { maxBytes: 8 })).rejects.toThrow(
          /failed/,
        )
        await expect(fs[operation]?.(root, ctx, { maxBytes: 8 })).rejects.toThrow(/failed/)
      })
    }
    it("preserves exact binary bytes at the boundary and supports uncapped reads", async () => {
      const { root, fs, ctx } = setup()
      const path = join(root, "bytes")
      const bytes = Buffer.from([0, 255, 10, 13, 0, 128])
      writeFileSync(path, bytes)
      expect(await fs.readBinaryFile?.(path, ctx, { maxBytes: bytes.length })).toEqual(bytes)
      expect(await fs.readBinaryFile?.(path, ctx, { maxBytes: Infinity })).toEqual(bytes)
      writeFileSync(path, "")
      expect(await fs.readBinaryFile?.(path, ctx, { maxBytes: 0 })).toEqual(Buffer.alloc(0))
    })
  })
}
