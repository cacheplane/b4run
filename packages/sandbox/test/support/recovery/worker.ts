import { RecoveryCoordinator } from "./coordinator.ts"
import { RecoveryDocker } from "./docker.ts"
import { loadFixtureManifest } from "./manifest.ts"
import { RecoveryStore } from "./store.ts"
import type { FaultPoint } from "./types.ts"

interface Request {
  stateDir: string
  logicalId: string
  fixture: "cli-flags" | "nullable-inputs"
  image: string
  command: "create" | "reconnect" | "destroy"
  pause?: FaultPoint
  edit?: boolean
}

const request = JSON.parse(process.argv[2] ?? "{}") as Request
const send = (value: unknown) => process.send?.(value)
let store: RecoveryStore | undefined
try {
  store = RecoveryStore.open(request.stateDir)
  const hook = async (point: FaultPoint) => {
    if (request.pause === point) {
      send({ kind: "paused", point })
      // The IPC channel keeps this process alive until the parent injects a crash.
      await new Promise(() => {})
    }
  }
  const resources = new RecoveryDocker(undefined, hook)
  const coordinator = new RecoveryCoordinator(store, resources, hook)
  if (request.command === "destroy") {
    await coordinator.destroy(request.logicalId)
    send({ kind: "done" })
  } else {
    const result =
      request.command === "create"
        ? await coordinator.create(
            request.logicalId,
            await loadFixtureManifest(request.fixture),
            await resources.resolveImage(request.image),
          )
        : await coordinator.reconnect(request.logicalId)
    const baseline = resources.result(
      await resources.docker.exec(result.sessionId, ["git", "rev-parse", "HEAD"]),
    )
    const sourcePath = result.record.source.files.find((file) => file.path.startsWith("src/"))?.path
    if (!sourcePath) throw new Error("Fixture has no source file")
    if (request.edit)
      resources.result(
        await resources.docker.exec(result.sessionId, [
          "node",
          "-e",
          "require('fs').writeFileSync(process.argv[1],'// retained after host restart\\n')",
          sourcePath,
        ]),
      )
    const edit = await resources.docker.exec(result.sessionId, [
      "node",
      "-e",
      "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
      sourcePath,
    ])
    await coordinator.release(request.logicalId)
    send({ kind: "done", record: result.record, baseline, edit: resources.result(edit) })
  }
} catch (error) {
  send({ kind: "error", message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  store?.close()
  process.disconnect?.()
}
