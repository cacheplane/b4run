import { resolve } from "node:path"
import {
  type DrafterEndpoint,
  type FactoryConfig,
  loadConfig,
  type WorkerEndpoint,
} from "./config.js"
import { createFactory, type Factory, type FactoryOptions } from "./controller/factory.js"
import { createWorkerMap } from "./controller/workers.js"
import { createArtifactStore } from "./storage/artifacts.js"
import {
  configureCatalog,
  configuredImages,
  configureImages,
  loadTask,
  resetCatalogForTests,
} from "./targets/catalog.js"
import { dockerImageBuilder } from "./targets/image-builder.js"
import { type ImageRegistry, openImageRegistry } from "./targets/images.js"
import { drafterInspectionOptions, targetInspectionOptions } from "./targets/workspace.js"
import { captureTargetBaseline } from "./verification/baseline.js"
import { createDockerVerifier } from "./verification/docker-verifier.js"
import { createHttpWorkerClient } from "./worker/client.js"
import { createHttpThreadWorkspaceReader, type WorkspaceReader } from "./worker/workspace-reader.js"

/**
 * The collaborators a test may replace. Everything else the runtime builds is real: only
 * those that need a container, a worker installation on disk, a target checkout or the
 * repository at a pin are injectable, so a test can drive the REAL routes without those.
 * The readers are keyed by role: the worker map itself (clients, routes, app roots) is the
 * configuration's, and a test points its two fake workers at it through the environment.
 */
export type ControllerRuntimeOverrides = Partial<
  Pick<
    FactoryOptions,
    | "verifier"
    | "captureBaseline"
    | "captureDrafterHandoff"
    | "captureBuilderHandoff"
    | "allowBudgetBelowVerifierDeadline"
  >
> & {
  readonly readers?: {
    /** Replaces the one builder's reader. */
    readonly builder?: WorkspaceReader
    readonly drafter?: WorkspaceReader
  }
  /** Replaces the registry the runtime would open at `<stateDir>/images.sqlite`; left open on dispose. */
  readonly images?: ImageRegistry
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
  for (const warning of config.warnings)
    process.stderr.write(`${JSON.stringify({ event: "config_ignored", warning })}\n`)
  let opening: Promise<Factory> | undefined
  let disposed = false
  let images: ImageRegistry | undefined
  let ownsImages = false
  let previousImages: ImageRegistry | undefined
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
      releaseImages()
    },
  }

  /** Put back the registry configured before this runtime opened its own, and close its own. */
  function releaseImages(): void {
    if (images === undefined) return
    if (configuredImages() === images) configureImages(previousImages)
    if (ownsImages) images.close()
    images = undefined
  }

  function openFactory(): Promise<Factory> {
    // Async from the first line: opening the image registry can throw (an unwritable state
    // directory), and a throw must reach the caller as this promise's rejection, released.
    return (async () => openFactoryNow())().catch((error) => {
      // A failed open is retried by the next caller, like middleware setup itself, and leaves
      // no registry configured or open behind it.
      opening = undefined
      releaseImages()
      throw error
    })
  }

  function openFactoryNow(): Promise<Factory> {
    // Once per runtime, before the factory and its collaborators exist: every `loadTask(id)`
    // below — the prompt, the verifier, the baseline, the workspace reader — then finds a
    // generated task. The search path is process-wide, like the runtime itself.
    configureCatalog({ generatedTasksDir: config.generatedTasksDir })
    const { readers, images: injected, ...factoryOverrides } = overrides
    // The host's images: opened here (or injected by a test), and configured process-wide so
    // every `loadTarget` reads the image recorded for its recipe. Restored on dispose.
    previousImages = configuredImages()
    images =
      injected ??
      openImageRegistry({
        path: config.imagesPath,
        builder: dockerImageBuilder(),
        maxConcurrentBuilds: config.maxImageBuilds,
        buildTimeoutMs: config.imageBuildTimeoutMs,
      })
    ownsImages = injected === undefined
    configureImages(images)
    // Every run-time file the controller stages (captures, verifier state) lives under its
    // state directory, never under its own app root: `b4 dev` restarts the server on any write
    // under the app root it does not ignore, and did so mid-`intake` the first time the factory
    // ran under it. Absolute, because the framework's capture resolves against it.
    const captureRoot = resolve(config.stateDir)
    const workers = createWorkerMap(config, {
      createClient: (url) => createHttpWorkerClient(url, { token: config.workerToken }),
      createBuilderReader: (entry) => readers?.builder ?? builderReader(entry),
      // Each worker is read over its own URL with the worker token; the drafter's threads are
      // read re-rooted at `draft/`, so the wide capture under `repo/` is never walked.
      createDrafterReader: (entry) => readers?.drafter ?? drafterReader(entry),
    })
    return createFactory({
      registryPath: config.registryPath,
      workers,
      exportDir: config.exportDir,
      artifactsDir: config.artifactsDir,
      generatedTasksDir: config.generatedTasksDir,
      captureRoot,
      approvalTtlMs: config.approvalTtlMs,
      maxActiveMs: config.maxActiveMs,
      maxIntakeAttempts: config.maxIntakeAttempts,
      maxCandidateAttempts: config.maxCandidateAttempts,
      maxChangedBytes: config.maxChangedBytes,
      verifier: createDockerVerifier(createArtifactStore(config.artifactsDir), {
        stagingRoot: captureRoot,
      }),
      captureBaseline: (taskId, signal) => captureTargetBaseline(taskId, signal, { captureRoot }),
      // Defined keys only: an explicit `{ verifier: undefined }` must not erase a required
      // collaborator, which a plain spread would do.
      ...definedOnly(factoryOverrides),
      log: (event, payload) => process.stderr.write(`${JSON.stringify({ event, ...payload })}\n`),
    })
  }

  /**
   * The builder's reader: `POST /threads/:id/workspace/inspect` on the builder's URL, with the
   * worker token. The inspection options are the task's own.
   */
  function builderReader(entry: WorkerEndpoint): WorkspaceReader {
    return createHttpThreadWorkspaceReader(
      { url: entry.url, token: config.workerToken },
      (taskId) => targetInspectionOptions(loadTask(requireTaskId(taskId))),
    )
  }

  /** The drafter's reader: the same, on the drafter's URL, re-rooted at `draft/`. */
  function drafterReader(entry: DrafterEndpoint): WorkspaceReader {
    return createHttpThreadWorkspaceReader({ url: entry.url, token: config.workerToken }, () => ({
      ...drafterInspectionOptions(),
      root: "draft",
    }))
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
