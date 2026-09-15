import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const windows = process.platform === "win32"
const packageRoot = fileURLToPath(new URL("../", import.meta.url))

test("cold workspace install links b4 before build and launcher preserves args and exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-cold-bin-"))
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      name: string
      version: string
      type: string
      bin: { b4: string }
      files: string[]
    }
    const cli = join(root, "cli")
    const app = join(root, "app")
    await mkdir(cli)
    await mkdir(app)
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - cli\n  - app\n")
    await writeFile(
      join(cli, "package.json"),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        bin: manifest.bin,
        files: manifest.files,
      }),
    )
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "cold-bin-consumer",
        private: true,
        dependencies: { [manifest.name]: "workspace:*" },
      }),
    )
    const launcher = join(packageRoot, manifest.bin.b4)
    // Copy only a checked-in launcher; the cold fixture must never receive dist.
    if (!manifest.bin.b4.startsWith("./dist/")) {
      await mkdir(dirname(join(cli, manifest.bin.b4)), { recursive: true })
      await copyFile(launcher, join(cli, manifest.bin.b4))
      await chmod(join(cli, manifest.bin.b4), 0o755)
    }
    const install = spawnSync(
      windows ? "pnpm.cmd" : "pnpm",
      ["install", "--offline", "--ignore-scripts", "--lockfile=false"],
      {
        cwd: root,
        shell: windows,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, CI: "true" },
      },
    )
    expect(install.status, install.stdout + install.stderr).toBe(0)
    const bin = join(app, "node_modules", ".bin", windows ? "b4.cmd" : "b4")
    expect(
      await stat(bin).then(
        () => true,
        () => false,
      ),
      install.stdout + install.stderr,
    ).toBe(true)
    expect(
      await stat(join(cli, "dist")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await mkdir(join(cli, "dist"))
    await writeFile(
      join(cli, "dist", "index.js"),
      `
export async function run(args) {
  if (args[0] === "reject") throw new Error("broken")
  process.stdout.write(JSON.stringify(args))
  return args[0] === "fail" ? 7 : 0
}
export function renderError(error) { return "rendered: " + error.message }
`,
    )
    for (const args of [["hello", "space argument", "--flag"], ["fail"], ["reject"]]) {
      // cmd shims need a shell; quote the fixed test arguments to retain spaces.
      // Use a relative command on Windows so the temp path is never shell text.
      const result = spawnSync(
        windows ? ".\\node_modules\\.bin\\b4.cmd" : bin,
        windows ? args.map((arg) => `"${arg}"`) : args,
        { cwd: app, shell: windows, encoding: "utf8", timeout: 10_000 },
      )
      expect(result.status).toBe(args[0] === "reject" ? 1 : args[0] === "fail" ? 7 : 0)
      expect(result.stdout).toBe(args[0] === "reject" ? "" : JSON.stringify(args))
      expect(result.stderr).toBe(args[0] === "reject" ? "rendered: broken\n" : "")
    }
    expect(manifest.files).toContain("bin")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)
