import { execFileSync, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanupEvaluation } from "../evaluation/cleanup.js"
import { exerciseConsumer } from "./consumer-probe.js"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))
const appRoot = join(repoRoot, "examples/code-fixer/server")
const args = process.argv.slice(2)
const packed = args.length === 1 && args[0] === "--packed"
const version = args[0] === "--version" && args.length === 2 ? args[1] : undefined
if (!packed && !/^0\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("Choose --packed (build libraries first) or --version <exact published version>")
}
const temporary = await mkdtemp(join(tmpdir(), "b4-code-fixer-consumer-"))
const consumer = join(temporary, "app")
const commands: { command: string[]; status: number | null; durationMs: number }[] = []
const receipt: Record<string, unknown> = {
  passed: false,
  mode: packed ? "packed" : "published",
  version,
  commands,
}

export async function run(executable: string, args: string[], cwd: string, env = process.env) {
  console.log(`Consumer: ${executable} ${args.join(" ")}`)
  const started = performance.now()
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-1024 * 1024)
  }
  child.stdout.on("data", capture)
  child.stderr.on("data", capture)
  const timeout = setTimeout(() => child.kill("SIGKILL"), 600_000)
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    commands.push({
      command: [executable, ...args],
      status,
      durationMs: Math.round(performance.now() - started),
    })
    if (status !== 0) throw new Error(`Consumer failed: ${executable} ${args.join(" ")}\n${output}`)
    return output
  } finally {
    clearTimeout(timeout)
  }
}

try {
  await cp(appRoot, consumer, {
    recursive: true,
    filter: (path) =>
      !["node_modules", "artifacts", ".b4"].includes(basename(path)) &&
      !basename(path).startsWith(".env"),
  })
  const pkg = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"))
  const replacements: Record<string, string> = {}
  if (packed) {
    const manifests = new Map<
      string,
      { directory: string; dependencies?: Record<string, string> }
    >()
    for (const directory of await readdir(join(repoRoot, "packages"))) {
      const manifest = JSON.parse(
        await readFile(join(repoRoot, "packages", directory, "package.json"), "utf8"),
      )
      manifests.set(manifest.name, { directory, dependencies: manifest.dependencies })
    }
    const queue = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
      name.startsWith("@b4run/"),
    )
    const names = new Set<string>()
    while (queue.length) {
      const name = queue.pop()!
      if (names.has(name)) continue
      names.add(name)
      const manifest = manifests.get(name)
      if (!manifest) throw new Error(`Missing local package: ${name}`)
      for (const [dependency, spec] of Object.entries(manifest.dependencies ?? {}))
        if (spec.startsWith("workspace:")) queue.push(dependency)
    }
    for (const name of names) {
      const destination = join(temporary, "packs", name.replace("/", "-"))
      await mkdir(destination, { recursive: true })
      execFileSync("pnpm", ["--filter", name, "pack", "--pack-destination", destination], {
        cwd: repoRoot,
        stdio: "pipe",
      })
      const tarball = (await readdir(destination)).find((file) => file.endsWith(".tgz"))
      if (!tarball) throw new Error(`No packed artifact: ${name}`)
      replacements[name] = `file:${join(destination, tarball)}`
    }
    pkg.overrides = replacements
  }
  for (const dependencies of [pkg.dependencies, pkg.devDependencies])
    for (const [name, spec] of Object.entries(dependencies))
      if (String(spec).startsWith("workspace:"))
        dependencies[name] = packed ? replacements[name] : version
  await writeFile(join(consumer, "package.json"), JSON.stringify(pkg, null, 2))
  for (const command of [
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ],
    ["run", "lint"],
    ["run", "check"],
    ["run", "build"],
    ["run", "typecheck"],
    ["test"],
    ["run", "test:sandbox"],
  ])
    await run("npm", command, consumer)
  await exerciseConsumer(consumer, run)
  receipt.passed = true
} catch (error) {
  receipt.error = String(error)
  process.exitCode = 1
} finally {
  try {
    await cleanupEvaluation(consumer)
  } catch (error) {
    receipt.cleanupError = String(error)
    receipt.passed = false
    process.exitCode = 1
  }
  if (receipt.cleanupError === undefined) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify(receipt, null, 2))
}
