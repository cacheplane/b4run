import {
  type B4Config,
  BUILD_TARGET_NAMES,
  type BuildTargetName,
  type RouteManifest,
} from "@b4run/core"
import type { CommandIo } from "../../output.js"
import type { WorkspaceBuildArtifact } from "../workspace-artifact.js"
import { honoTarget } from "./hono.js"
import { langsmithTarget } from "./langsmith.js"
import { nodeTarget } from "./node.js"
import { vercelTarget } from "./vercel.js"

/**
 * Everything a build target needs to emit its artifacts. These are the real
 * objects `build.ts` already computes after the shared typegen pre-step — the
 * discovered route manifest and the resolved build output directory — passed
 * through unreshaped.
 */
export interface BuildEmitContext {
  /** Absolute path to the B4.run app root. */
  readonly workspaceArtifact?: WorkspaceBuildArtifact
  readonly appRoot: string
  /** Absolute path to the build output directory (`<appRoot>/.b4/build`). */
  readonly buildDir: string
  /** The discovered route manifest (routes + appRoot). */
  readonly manifest: RouteManifest
  /** Command IO for emitting warnings/notices during emit (optional). */
  readonly io?: CommandIo
  /** The loaded `b4.config.ts` `build` section, when the app has one. */
  readonly buildConfig?: NonNullable<B4Config["build"]>
  /**
   * Absolute directory the `vercel` target publishes to, already resolved
   * against the app root from `--out-dir` or `build.vercel.outDir`. Absent
   * means the default `<appRoot>/.vercel/output`.
   */
  readonly vercelOutputDir?: string
}

/**
 * A pluggable `b4 build` output target. Each target emits one flavor of
 * deployment artifact (a Node/Docker bundle, a LangSmith config, …) and
 * returns the absolute paths it wrote.
 */
export interface BuildTarget {
  /** Unique target name, referenced from `config.build.targets`. */
  readonly name: BuildTargetName
  /** Emit this target's artifacts. Returns the absolute paths written. */
  emit(ctx: BuildEmitContext): Promise<{ readonly artifacts: string[] }>
}

/**
 * Registry of known build targets, keyed by name.
 *
 * Typed as a `Record` over the union `@b4run/core` derives from
 * `BUILD_TARGET_NAMES`, so a target added here without a matching name in
 * core (or the reverse) is a compile error — the config type and the registry
 * cannot drift apart.
 */
export const buildTargets: Readonly<Record<BuildTargetName, BuildTarget>> = {
  node: nodeTarget,
  langsmith: langsmithTarget,
  hono: honoTarget,
  vercel: vercelTarget,
}

/**
 * Default targets emitted when `config.build.targets` is not set.
 *
 * `hono` and `vercel` are deliberately absent: edge targets serve an honest
 * SUBSET of B4.run (no sandbox, no workspace tooling) and need durable stores
 * configured, so they are opt-in via `build: { targets: [...] }` rather than
 * something every `b4 build` starts emitting.
 */
export const DEFAULT_BUILD_TARGETS: readonly BuildTargetName[] = ["node", "langsmith"]

/** All known target names (for validation / error messages). */
export function knownTargetNames(): readonly BuildTargetName[] {
  return BUILD_TARGET_NAMES
}
