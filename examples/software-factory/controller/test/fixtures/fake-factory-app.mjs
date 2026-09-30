// A stand-in for one factory app under `up`: answers /readyz and the controller's reconcile
// route, and appends to FAKE_APP_REPORT what it was started with. Secrets are reported as
// sha256 or presence, never as values.
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
import { createServer } from "node:http"

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
})
if (process.env.FAKE_APP_EXIT_EARLY === name) process.exit(7)
const server = createServer((request, response) => {
  if (request.url === "/readyz") {
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
    console.log(`${name} stopping`)
    server.close(() => process.exit(0))
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
