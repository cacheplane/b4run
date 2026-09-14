import { execFileSync, spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = fileURLToPath(new URL("../", import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), "b4-code-fixer-consumer-"))
const receipt: Record<string, unknown> = { passed: false, commands: [] }
const commands = receipt.commands as unknown[]
try {
  const version = execFileSync(
    "npm",
    ["view", "@b4run/sdk", "version", "--registry=https://registry.npmjs.org"],
    { encoding: "utf8", timeout: 30_000 },
  ).trim()
  if (!/^0\.\d+\.\d+$/.test(version)) throw new Error("Unexpected published release version")
  receipt.version = version
  await cp(appRoot, temporary, {
    recursive: true,
    filter: (path) =>
      !["node_modules", "artifacts", ".b4", ".env"].includes(basename(path)) &&
      !basename(path).startsWith(".env."),
  })
  const pkg = JSON.parse(await readFile(join(temporary, "package.json"), "utf8"))
  delete pkg.devDependencies["@b4run/config-typescript"]
  for (const dependencies of [pkg.dependencies, pkg.devDependencies])
    for (const [name, value] of Object.entries(dependencies))
      if (typeof value === "string" && value.startsWith("workspace:")) dependencies[name] = version
  await writeFile(join(temporary, "package.json"), JSON.stringify(pkg, null, 2))
  await mkdir(join(temporary, "config"))
  const configRoot = fileURLToPath(
    new URL("../../../../packages/config-typescript/", import.meta.url),
  )
  for (const name of ["node.json", "library.json", "base.json"])
    await cp(join(configRoot, name), join(temporary, "config", name))
  const tsconfig = JSON.parse(await readFile(join(temporary, "tsconfig.json"), "utf8"))
  tsconfig.extends = "./config/node.json"
  await writeFile(join(temporary, "tsconfig.json"), JSON.stringify(tsconfig, null, 2))
  for (const args of [
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ],
    ["run", "check"],
    ["run", "build"],
    ["run", "typecheck"],
    ["test"],
    ["run", "eval:live", "--", "--replay", "--attempts", "1"],
  ]) {
    const started = performance.now()
    const result = spawnSync("npm", args, {
      cwd: temporary,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    commands.push({
      command: ["npm", ...args],
      status: result.status,
      durationMs: Math.round(performance.now() - started),
    })
    if (result.status !== 0 || result.error)
      throw new Error(
        `Consumer command failed: npm ${args.join(" ")}\n${result.error ?? result.stdout + result.stderr}`,
      )
  }
  receipt.passed = true
} catch (error) {
  receipt.error = String(error)
  process.exitCode = 1
} finally {
  await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify(receipt, null, 2))
}
