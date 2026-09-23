import { mkdirSync, statSync } from "node:fs"
import {
  type DrafterEndpoint,
  type FactoryConfig,
  loadConfig,
  type WorkerEndpoint,
} from "./config.js"
import { createFactory, type Factory, type FactoryOptions } from "./controller/factory.js"
import { createWorkerMap } from "./controller/workers.js"
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
 * those that need a container, a worker installation on disk, a target checkout or the
 * repository at a pin are injectable, so a test can drive the REAL routes without those.
 * The readers are keyed by role: the worker map itself (clients, routes, app roots) is the
 * configuration's, and a test points its two fake workers at it through the environment.
 */
export type ControllerRuntimeOverrides = Partial<
  Pick<FactoryOptions, "verifier" | "captureBaseline" | "writeDrafterManifest">
> & {
  readonly readers?: {
    /** Replaces the reader of EVERY builder worker entry. */
    readonly builder?: WorkspaceReader
    readonly drafter?: WorkspaceReader
  }
}

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
    // app has booted, and starting the controller first is a valid order. The manifest
    // directory is the controller's own to make: the drafter only reads it.
    if (config.drafter !== undefined) {
      if (!isDirectory(config.drafter.appRoot))
        return Promise.reject(
          new Error(`FACTORY_DRAFTER_APP_ROOT is not a directory (${config.drafter.appRoot})`),
        )
      try {
        mkdirSync(config.drafter.manifestDir, { recursive: true })
      } catch (error) {
        return Promise.reject(
          new Error(
            `FACTORY_DRAFTER_MANIFEST_DIR could not be created (${config.drafter.manifestDir}): ${String(error)}`,
          ),
        )
      }
    }
    const { readers, ...factoryOverrides } = overrides
    const workers = createWorkerMap(config, {
      createClient: createHttpWorkerClient,
      createBuilderReader: (entry) => readers?.builder ?? builderReader(entry),
      // The drafter's threads live under ITS app root, addressed by a provider of its scope
      // and image, and are read re-rooted at `draft/`: the wide capture under `repo/` is
      // never walked.
      createDrafterReader: (entry) => readers?.drafter ?? drafterReader(entry),
    })
    return createFactory({
      registryPath: config.registryPath,
      workers,
      exportDir: config.exportDir,
      artifactsDir: config.artifactsDir,
      generatedTasksDir: config.generatedTasksDir,
      approvalTtlMs: config.approvalTtlMs,
      maxActiveMs: config.maxActiveMs,
      maxChangedBytes: config.maxChangedBytes,
      verifier: createDockerVerifier(createArtifactStore(config.artifactsDir)),
      captureBaseline: captureTargetBaseline,
      // Defined keys only: an explicit `{ verifier: undefined }` must not erase a required
      // collaborator, which a plain spread would do.
      ...definedOnly(factoryOverrides),
      log: (event, payload) => process.stderr.write(`${JSON.stringify({ event, ...payload })}\n`),
    }).catch((error) => {
      // A failed open is retried by the next caller, like middleware setup itself.
      opening = undefined
      throw error
    })
  }

  /** A builder entry's reader: the provider is the task's target's, the store the entry's. */
  function builderReader(entry: WorkerEndpoint): WorkspaceReader {
    return createThreadWorkspaceReader(
      {
        providerFor: (taskId) => builderSandboxProvider(loadTask(requireTaskId(taskId)).target),
        appRoot: entry.appRoot,
      },
      (taskId) => targetInspectionOptions(loadTask(requireTaskId(taskId))),
    )
  }

  function drafterReader(entry: DrafterEndpoint): WorkspaceReader {
    return namingDrafterAppRoot(
      createThreadWorkspaceReader(
        {
          providerFor: () => drafterSandboxProvider(config.drafterImage),
          appRoot: entry.appRoot,
        },
        () => ({ ...drafterInspectionOptions(), root: "draft" }),
      ),
      entry.appRoot,
    )
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
        // Matched by text: the framework throws a plain `Error` here
        // (`openWorkspaceInstallationReader` in
        // `packages/sqlite-storage/src/workspace/installation.ts`, "No workspace installation
        // under <appRoot>"), with no class or code to test for.
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
function definedOnly<T extends object>(overrides: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<T>
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
