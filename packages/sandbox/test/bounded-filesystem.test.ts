import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerFilesystem } from "../src/docker/docker-filesystem.ts"
import type { KubeClient } from "../src/kubernetes/kube-client.ts"
import { kubeFilesystem } from "../src/kubernetes/kube-filesystem.ts"

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
      const run = (argv: string[], stdin?: string) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
          const child = spawn(argv[0] as string, argv.slice(1))
          const out: Buffer[] = []
          const err: Buffer[] = []
          child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
          child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
          child.on("error", reject)
          child.stdin.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "EPIPE") reject(error)
          })
          child.on("close", (code) => {
            const stdout = Buffer.concat(out).toString("utf8")
            outputSizes.push(Buffer.byteLength(stdout))
            resolve({ stdout, stderr: Buffer.concat(err).toString("utf8"), exitCode: code ?? 1 })
          })
          child.stdin.end(stdin ?? "")
        })
      const argvs: string[][] = []
      const fs =
        provider === "docker"
          ? dockerFilesystem(
              {
                exec: (_container: string, argv: string[], opts?: { stdin?: string }) => {
                  argvs.push(argv)
                  return run(argv, opts?.stdin)
                },
              } as unknown as Docker,
              "container",
            )
          : kubeFilesystem(
              {
                exec: (_ns: string, _pod: string, argv: string[], opts?: { stdin?: string }) => {
                  argvs.push(argv)
                  return run(argv, opts?.stdin)
                },
              } as unknown as KubeClient,
              "ns",
              "pod",
            )
      return {
        root,
        outputSizes,
        argvs,
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
    it("batch-reads exact bytes through a real shell, keeping each file's bound", async () => {
      const { root, fs, ctx, argvs } = setup()
      const names = ["quote'file", "sp ace", "caf\u00e9", "new\nline", "empty"]
      const contents = [
        Buffer.from([0, 255, 10]),
        Buffer.from("a b"),
        Buffer.from("x"),
        Buffer.from("n"),
        Buffer.alloc(0),
      ]
      names.forEach((name, i) => {
        writeFileSync(join(root, name), contents[i] as Buffer)
      })
      const many = Array.from({ length: 600 }, (_, i) => {
        const path = join(root, `${"long-name-".repeat(8)}${i}`)
        writeFileSync(path, String(i))
        return { path, maxBytes: String(i).length }
      })
      const requests = [
        ...names.map((name, i) => ({
          path: join(root, name),
          maxBytes: (contents[i] as Buffer).length,
        })),
        ...many,
      ]
      const read = await fs.readBinaryFiles?.(requests, ctx)
      expect(read?.slice(0, names.length).map((bytes) => Buffer.from(bytes))).toEqual(contents)
      expect(Buffer.from(read?.[requests.length - 1] as Uint8Array).toString()).toBe("599")
      // More than one exec, and on Kubernetes the script never rides in argv.
      expect(argvs.length).toBeGreaterThan(1)
      for (const argv of argvs)
        if (provider === "kube") expect(argv).toEqual(["sh", "-s"])
        else expect(argv[0]).toBe("sh")

      await expect(
        fs.readBinaryFiles?.([{ path: join(root, "sp ace"), maxBytes: 2 }], ctx),
      ).rejects.toThrow(/maxBytes/)
      await expect(
        fs.readBinaryFiles?.([{ path: join(root, "absent"), maxBytes: 2 }], ctx),
      ).rejects.toThrow(/failed/)
    })
  })
}
