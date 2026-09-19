import { parseArgs } from "node:util"
import { loadConfig } from "./config.js"
import { createFactory, type Factory } from "./controller/factory.js"
import { ACTIVE_STATES } from "./domain/states.js"
import { builderSandboxProvider, workspaceInspectionOptions } from "./fixtures/workspace.js"
import { createHttpApi } from "./http.js"
import { createArtifactStore } from "./storage/artifacts.js"
import { captureFixtureBaseline } from "./verification/baseline.js"
import { createDockerVerifier } from "./verification/docker-verifier.js"
import { createHttpWorkerClient } from "./worker/client.js"
import { createThreadWorkspaceReader } from "./worker/workspace-reader.js"

const USAGE = `factory <command> [options]

  create   --task <id> [--key <operationKey>]
  dispatch <workOrderId> [--wait] [--key <operationKey>]
  approve  <workOrderId> --revision <n> --bundle <sha256> [--key <operationKey>]
  deny     <workOrderId> [--key <operationKey>]
  cancel   <workOrderId> [--key <operationKey>]
  show     <workOrderId>
  events   <workOrderId>
  evidence <workOrderId>
  list
  serve    [--port <n>]

Environment: FACTORY_WORKER_URL, FACTORY_STATE_DIR (required);
FACTORY_WORKER_ROUTE, FACTORY_EXPORT_DIR, FACTORY_ARTIFACTS_DIR, FACTORY_APPROVAL_TTL_MS,
FACTORY_MAX_ACTIVE_MS, FACTORY_MAX_CHANGED_BYTES, FACTORY_HTTP_PORT.
Output is JSON on stdout; diagnostics go to stderr. Exit code 1 when a command is refused.`

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      key: { type: "string" },
      revision: { type: "string" },
      bundle: { type: "string" },
      port: { type: "string" },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  const [command, id] = positionals
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`)
    return command ? 0 : 1
  }
  const config = loadConfig(process.env)
  const factory: Factory = await createFactory({
    registryPath: config.registryPath,
    worker: createHttpWorkerClient(config.workerUrl),
    workerRoute: config.workerRoute,
    exportDir: config.exportDir,
    artifactsDir: config.artifactsDir,
    approvalTtlMs: config.approvalTtlMs,
    maxActiveMs: config.maxActiveMs,
    maxChangedBytes: config.maxChangedBytes,
    verifier: createDockerVerifier(createArtifactStore(config.artifactsDir)),
    workspaceReader: createThreadWorkspaceReader(
      builderSandboxProvider(),
      workspaceInspectionOptions,
    ),
    captureBaseline: captureFixtureBaseline,
  })
  const needId = () => {
    if (!id) throw new Error(`${command} requires a work order id`)
    return id
  }
  try {
    switch (command) {
      case "create": {
        if (!values.task) throw new Error("create requires --task")
        print(
          await factory.create({
            taskId: values.task,
            ...(values.key ? { operationKey: values.key } : {}),
          }),
        )
        return 0
      }
      case "dispatch": {
        const outcome = await factory.dispatch(needId(), values.key)
        if (!outcome.ok) {
          print(outcome)
          return 1
        }
        if (values.wait) {
          print(
            await factory.waitFor(
              needId(),
              // Every state that still owes the operator work, not just the two the
              // worker drives: `verifying` is the controller's own phase and a wait that
              // stopped there would report a work order that is still moving.
              (r) => !ACTIVE_STATES.has(r.state),
              config.maxActiveMs + 60_000,
            ),
          )
        } else print(outcome)
        return 0
      }
      case "approve": {
        if (!values.revision || !values.bundle)
          throw new Error("approve requires --revision and --bundle")
        const outcome = await factory.approve(needId(), {
          revision: Number(values.revision),
          bundleDigest: values.bundle,
          ...(values.key ? { operationKey: values.key } : {}),
        })
        print({ ...outcome, ...factory.show(needId()) })
        return outcome.ok ? 0 : 1
      }
      case "deny":
      case "cancel": {
        const outcome =
          command === "deny"
            ? await factory.deny(needId(), values.key)
            : await factory.cancel(needId(), values.key)
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "show": {
        const row = factory.show(needId())
        if (!row) throw new Error(`Unknown work order ${id}`)
        print(row)
        return 0
      }
      case "events":
        print(factory.events(needId()))
        return 0
      case "evidence":
        print(factory.evidence(needId()))
        return 0
      case "list":
        print(factory.list())
        return 0
      case "serve": {
        const api = await createHttpApi(factory).listen(
          values.port ? Number(values.port) : config.httpPort,
        )
        process.stderr.write(`factory listening on ${api.baseUrl}\n`)
        await new Promise<void>((resolve) => {
          const stop = () => {
            api.close().then(resolve, resolve)
          }
          process.once("SIGINT", stop)
          process.once("SIGTERM", stop)
        })
        return 0
      }
      default:
        throw new Error(`Unknown command ${command}\n${USAGE}`)
    }
  } finally {
    await factory.close()
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)
