import type { RouteManifest } from "@b4run/core"
import type { CommandIo } from "../../output.js"
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
  readonly appRoot: string
  /** Absolute path to the build output directory (`<appRoot>/.b4/build`). */
  readonly buildDir: string
  /** The discovered route manifest (routes + appRoot). */
  readonly manifest: RouteManifest
  /** Command IO for emitting warnings/notices during emit (optional). */
  readonly io?: CommandIo
}

/**
 * A pluggable `b4 build` output target. Each target emits one flavor of
 * deployment artifact (a Node/Docker bundle, a LangSmith config, …) and
 * returns the absolute paths it wrote.
 */
export interface BuildTarget {
  /** Unique target name, referenced from `config.build.targets`. */
  readonly name: string
  /** Emit this target's artifacts. Returns the absolute paths written. */
  emit(ctx: BuildEmitContext): Promise<{ readonly artifacts: string[] }>
}

/** Registry of known build targets, keyed by name. */
export const buildTargets: Readonly<Record<string, BuildTarget>> = {
  [nodeTarget.name]: nodeTarget,
  [langsmithTarget.name]: langsmithTarget,
  [honoTarget.name]: honoTarget,
  [vercelTarget.name]: vercelTarget,
}

/**
 * Default targets emitted when `config.build.targets` is not set.
 *
 * `hono` and `vercel` are deliberately absent: edge targets serve an honest
 * SUBSET of B4.run (no sandbox, no workspace tooling) and need durable stores
 * configured, so they are opt-in via `build: { targets: [...] }` rather than
 * something every `b4 build` starts emitting.
 */
export const DEFAULT_BUILD_TARGETS: readonly string[] = ["node", "langsmith"]

/** All known target names (for validation / error messages). */
export function knownTargetNames(): string[] {
  return Object.keys(buildTargets)
}
