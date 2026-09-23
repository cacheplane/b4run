import { statSync } from "node:fs"
import { type FactoryConfig, loadConfig } from "./config.js"
import { createFactory, type Factory, type FactoryOptions } from "./controller/factory.js"
import { createArtifactStore } from "./storage/artifacts.js"
import { configureCatalog, loadTask, resetCatalogForTests } from "./targets/catalog.js"
import {
  builderSandboxProvider,
  drafterInspectionOptions,
  drafterSandboxProvider,
  targetInspectionOptions,
} from "./targets/workspace.js"
import { captureTargetBaseline } from "./verification/baseline.js"
import { createDockerVerifier } from "./verification/docker-verifier.js"
import { createHttpWorkerClient } from "./worker/client.js"
import { createThreadWorkspaceReader, type WorkspaceReader } from "./worker/workspace-reader.js"

/**
 * The collaborators a test may replace. Everything else the runtime builds is real: only
 * the three that need a container, a builder installation on disk, or a target checkout
 * are injectable, so a test can drive the REAL routes without those.
 */
export type ControllerRuntimeOverrides = Partial<
  Pick<FactoryOptions, "verifier" | "workspaceReader" | "drafterReader" | "captureBaseline">
>

export interface ControllerRuntime {
  readonly config: FactoryConfig
  /** The process's one Factory, opened on first use. Concurrent first calls share the open. */
  factory(): Promise<Factory>
  dispose(): Promise<void>
}

/**
 * One Factory per process, opened lazily because b4 has no boot hook: the app's middleware
 * `setup` calls `factory()` before the first request and `dispose()` on shutdown. Every
 * route reaches the same instance, so the registry has exactly one writer.
 */
export function createControllerRuntime(
  env: Readonly<Record<string, string | undefined>>,
  overrides: ControllerRuntimeOverrides = {},
): ControllerRuntime {
  const config = loadConfig(env)
  let opening: Promise<Factory> | undefined
  let disposed = false
  return {
    config,
    factory() {
      if (disposed) return Promise.reject(new Error("Controller runtime is disposed"))
      opening ??= openFactory()
      return opening
    },
    async dispose() {
      disposed = true
      const factory = await opening?.catch(() => undefined)
      await factory?.close()
    },
  }

  function openFactory(): Promise<Factory> {
    // Once per runtime, before the factory and its collaborators exist: every `loadTask(id)`
    // below — the prompt, the verifier, the baseline, the workspace reader — then finds a
    // generated task. The search path is process-wide, like the runtime itself.
    configureCatalog({ generatedTasksDir: config.generatedTasksDir })
    // The drafter app root is what every drafter thread is resolved through: a path that is
    // not a directory is refused at boot, not after a drafter turn has been spent on it. Only
    // the directory is checked — its `.b4/workspaces` store does not exist until the drafter
    // app has booted, and starting the controller first is a valid order.
    if (config.drafterAppRoot !== undefined && !isDirectory(config.drafterAppRoot)) {
      return Promise.reject(
        new Error(`FACTORY_DRAFTER_APP_ROOT is not a directory (${config.drafterAppRoot})`),
      )
    }
    return createFactory({
      registryPath: config.registryPath,
      worker: createHttpWorkerClient(config.workerUrl),
      workerRoute: config.workerRoute,
      exportDir: config.exportDir,
      artifactsDir: config.artifactsDir,
      generatedTasksDir: config.generatedTasksDir,
      intakeRoute: config.intakeRoute,
      approvalTtlMs: config.approvalTtlMs,
      maxActiveMs: config.maxActiveMs,
      maxChangedBytes: config.maxChangedBytes,
      verifier: createDockerVerifier(createArtifactStore(config.artifactsDir)),
      workspaceReader: createThreadWorkspaceReader(
        {
          providerFor: (taskId) => builderSandboxProvider(loadTask(requireTaskId(taskId)).target),
          appRoot: config.builderAppRoot,
        },
        (taskId) => targetInspectionOptions(loadTask(requireTaskId(taskId))),
      ),
      // The drafter's threads live under ITS app root, addressed by a provider of its scope
      // and image, and are read re-rooted at `draft/`: the wide capture under `repo/` is
      // never walked. Only when a drafter app root is configured; otherwise `intake` refuses.
      ...(config.drafterAppRoot !== undefined
        ? {
            drafterReader: namingDrafterAppRoot(
              createThreadWorkspaceReader(
                {
                  providerFor: () => drafterSandboxProvider(config.drafterImage),
                  appRoot: config.drafterAppRoot,
                },
                () => ({ ...drafterInspectionOptions(), root: "draft" }),
              ),
              config.drafterAppRoot,
            ),
          }
        : {}),
      captureBaseline: captureTargetBaseline,
      // Defined keys only: an explicit `{ verifier: undefined }` must not erase a required
      // collaborator, which a plain spread would do.
      ...definedOnly(overrides),
      log: (event, payload) => process.stderr.write(`${JSON.stringify({ event, ...payload })}\n`),
    }).catch((error) => {
      // A failed open is retried by the next caller, like middleware setup itself.
      opening = undefined
      throw error
    })
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * A drafter app root that exists but holds no installation store is the one read failure
 * whose cause is the operator's configuration (the drafter app never booted there, or it is
 * the wrong directory), not the thread's: the journal line names the variable to fix.
 */
function namingDrafterAppRoot(reader: WorkspaceReader, appRoot: string): WorkspaceReader {
  return {
    async read(target, signal) {
      try {
        return await reader.read(target, signal)
      } catch (error) {
        if (error instanceof Error && /No workspace installation/.test(error.message)) {
          throw new Error(
            `FACTORY_DRAFTER_APP_ROOT has no workspace installation: has the drafter app booted under ${appRoot}? (${error.message})`,
            { cause: error },
          )
        }
        throw error
      }
    },
  }
}

/** The builder's reader is addressed by thread AND task; a read without one is a caller fault. */
function requireTaskId(taskId: string | undefined): string {
  if (taskId === undefined) throw new Error("The builder workspace reader needs a task id")
  return taskId
}

/** A spread of `overrides` that cannot blank a field: `undefined` values are dropped. */
function definedOnly(overrides: ControllerRuntimeOverrides): ControllerRuntimeOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as ControllerRuntimeOverrides
}

/** The module-scope instance the app's middleware and routes share. */
let shared: ControllerRuntime | undefined
let sharedOverrides: ControllerRuntimeOverrides = {}
export function controllerRuntime(): ControllerRuntime {
  shared ??= createControllerRuntime(process.env, sharedOverrides)
  return shared
}
/**
 * Tests boot several controllers in one process with different environments. Disposes the
 * previous instance first: dropping it undisposed would leak its open registry and its
 * live AbortController. `overrides` apply to the instance the next call opens, which is how
 * a served app runs the real routes against scripted collaborators.
 */
export async function resetControllerRuntimeForTests(
  overrides: ControllerRuntimeOverrides = {},
): Promise<void> {
  await shared?.dispose()
  shared = undefined
  sharedOverrides = overrides
  resetCatalogForTests()
}
