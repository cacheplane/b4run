// A stand-in for one factory app under `up`: answers /readyz and the controller's reconcile
// route, and appends to FAKE_APP_REPORT what it was started with. Secrets are reported as
// sha256 or presence, never as values (only FAKE_APP_PRINT_SECRETS prints them, to prove up
// redacts its children's output).
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { dirname } from "node:path"

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const port = Number(option("--port"))
const host = option("--host")
const name = process.env.FAKE_APP_NAME
const report = (record) =>
  appendFileSync(process.env.FAKE_APP_REPORT, `${JSON.stringify({ name, ...record })}\n`)
const token = process.env.FACTORY_WORKER_TOKEN
report({
  pid: process.pid,
  host,
  port,
  cwd: process.cwd(),
  token: token ? createHash("sha256").update(token).digest("hex") : null,
  hasOpenaiKey: process.env.OPENAI_API_KEY !== undefined,
  workerUrl: process.env.FACTORY_WORKER_URL ?? null,
  drafterUrl: process.env.FACTORY_DRAFTER_URL ?? null,
  stateDir: process.env.FACTORY_STATE_DIR ?? null,
  // Rung 4: names and booleans only, never a value that could hold key material.
  deliveryVariables: Object.keys(process.env)
    .filter((variable) => /^FACTORY_(?:GITHUB_APP_|DELIVERY_)|APP_KEY/.test(variable))
    .sort(),
  pemInEnvironment: Object.values(process.env).some((value) => value?.includes("PRIVATE KEY")),
  keyFile: keyFileFacts(process.env.FACTORY_GITHUB_APP_PRIVATE_KEY_FILE),
})

/** Where the controller's key file is and whether it holds a key, private: never its content. */
function keyFileFacts(path) {
  if (path === undefined) return null
  try {
    return {
      path,
      mode: statSync(path).mode & 0o777,
      directoryMode: statSync(dirname(path)).mode & 0o777,
      isPem: readFileSync(path, "utf8").includes("PRIVATE KEY-----"),
    }
  } catch {
    return { path, missing: true }
  }
}
// A careless app that prints variables it was given: up must redact the secrets among them
// everywhere it copies the line. The test names the variables (FAKE_APP_ECHO), so this stand-in
// never names a secret itself; the values it prints are the test's fakes.
if (process.env.FAKE_APP_PRINT_SECRETS === name) {
  const echoed = (process.env.FAKE_APP_ECHO ?? "")
    .split(",")
    .filter((variable) => variable !== "")
    .map((variable) => `${variable}=${process.env[variable] ?? ""}`)
    .join(" ")
  console.log(`echo ${echoed}`)
  console.error(`stderr echo ${echoed}`)
}
// A helper left in the app's process group (not detached), which outlives the app itself.
if (process.env.FAKE_APP_SLEEPER === name) {
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" })
  sleeper.unref()
  report({ sleeper: sleeper.pid })
}
if (process.env.FAKE_APP_EXIT_EARLY === name) process.exit(7)
const server = createServer((request, response) => {
  if (request.url === "/readyz") {
    if (process.env.FAKE_APP_NEVER_READY === name) {
      response.writeHead(503)
      response.end()
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"status":"ready"}')
    return
  }
  if (request.method === "POST" && request.url === "/threads/controller/runs/wait") {
    report({ reconciled: true })
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"ok":true,"message":"Reconciled"}')
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, host, () => console.log(`${name} listening on ${host}:${port}`))
if (process.env.FAKE_APP_IGNORE_TERM === name) {
  process.on("SIGTERM", () => console.log(`${name} ignores SIGTERM`))
} else {
  process.on("SIGTERM", () => {
    report({ sigtermAt: Date.now() })
    console.log(`${name} stopping`)
    // A slow closer (the real controller takes seconds): what up does meanwhile is observable.
    const delay = process.env.FAKE_APP_SLOW_EXIT === name ? 1_000 : 0
    setTimeout(() => {
      report({ exitingAt: Date.now() })
      server.close(() => process.exit(0))
    }, delay)
  })
}
// Exits on its own once the controller has been reconciled: a child that dies after ready.
if (process.env.FAKE_APP_EXIT_AFTER_READY === name) {
  const watch = setInterval(() => {
    if (readFileSync(process.env.FAKE_APP_REPORT, "utf8").includes('"reconciled":true')) {
      clearInterval(watch)
      process.exit(9)
    }
  }, 50)
}
