import {
  type SandboxPolicy,
  type ThreadSandboxPolicy,
  WorkspaceLifecycleError,
} from "@b4run/workspace"

/**
 * The policy one thread's session runs under, from the app's and the thread's
 * recorded overrides:
 * - `resources` merge key by key; the thread's keys win.
 * - `env` replaces the app's whole.
 * - `network` keeps or narrows the app's. A thread mode equal to the app's keeps
 *   the app's network object (an app `allow` keeps its `denylist`); a thread
 *   `deny` under an app `allow` is `{ mode: "deny" }`; a thread `allow` under an
 *   app `deny` is refused rather than narrowed, so a resolver asking for more
 *   than the app grants hears about it. Checked again at every reconnect, so an
 *   app that later denies the network also stops threads that asked earlier.
 * - `security` is always the app's.
 */
export function threadPolicy(
  app: SandboxPolicy,
  thread: ThreadSandboxPolicy | undefined,
): SandboxPolicy {
  if (thread === undefined) return app
  const asked = thread.network?.mode
  if (app.network.mode === "deny" && asked === "allow")
    throw new WorkspaceLifecycleError(
      "unsupported",
      "A thread's sandbox policy may not open the network the app's policy denies",
    )
  const network: SandboxPolicy["network"] =
    asked === undefined || asked === app.network.mode ? app.network : { mode: "deny" }
  const env = thread.env ?? app.env
  const resources =
    thread.resources === undefined ? app.resources : { ...app.resources, ...thread.resources }
  return {
    network,
    ...(env !== undefined ? { env } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(app.security !== undefined ? { security: app.security } : {}),
  }
}
