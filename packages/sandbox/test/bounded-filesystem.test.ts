import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerFilesystem } from "../src/docker/docker-filesystem.ts"
import type { KubeClient } from "../src/kubernetes/kube-client.ts"
import { kubeFilesystem } from "../src/kubernetes/kube-filesystem.ts"
import { createHostShellFixture, type HostShellFixture } from "./helpers/host-shell-fixture.ts"

const fixtures: HostShellFixture[] = []
afterEach(async () => {
  const disposed = await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.close()))
  const failures = disposed.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []))
  if (failures.length) throw new AggregateError(failures, "Host-shell fixture cleanup failed")
})
for (const provider of ["docker", "kube"] as const) {
  describe(`${provider} bounded reads`, () => {
    function setup() {
      const fixture = createHostShellFixture()
      fixtures.push(fixture)
      const { root, outputSizes, run } = fixture
      const argvs: string[][] = []
      const fs =
        provider === "docker"
          ? dockerFilesystem(
              {
                exec: (
                  _container: string,
                  argv: string[],
                  opts?: { stdin?: string; signal?: AbortSignal },
                ) => {
                  argvs.push(argv)
                  expect(opts?.signal).toBe(fixture.ctx.signal)
                  return run(argv, opts?.stdin, opts?.signal)
                },
              } as unknown as Docker,
              "container",
            )
          : kubeFilesystem(
              {
                exec: (
                  _ns: string,
                  _pod: string,
                  argv: string[],
                  opts?: { stdin?: string; signal?: AbortSignal },
                ) => {
                  argvs.push(argv)
                  expect(opts?.signal).toBe(fixture.ctx.signal)
                  return run(argv, opts?.stdin, opts?.signal)
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
        ctx: fixture.ctx,
        fixture,
      }
    }
    it("forwards the actual caller signal before starting a pre-aborted read", async () => {
      const { root, fs, ctx, fixture, argvs } = setup()
      const path = join(root, "cancelled")
      writeFileSync(path, "bytes")
      const reason = new Error("pre-aborted adapter read")
      fixture.abort(reason)
      await expect(fs.readBinaryFile?.(path, ctx, { maxBytes: 5 })).rejects.toBe(reason)
      expect(argvs).toHaveLength(1)
      expect(fixture.children).toHaveLength(0)
    })
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
