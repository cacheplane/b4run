import type {
  RuntimeStorageFactory,
  RuntimeStorageInstallation,
  RuntimeStorageRegistrationOptions,
} from "@b4run/sdk/agent-protocol"

const registrations = new WeakMap<RuntimeStorageHost, RuntimeStorageRegistrationOptions>()
/** Boot-owned installation. Contains no caller scope, policy callback or store
 * accessor. HTTP bindings cannot install or replace its registration. */
export interface RuntimeStorageHost extends RuntimeStorageInstallation {
  close(): Promise<void>
}
export async function createRuntimeStorageHost(
  factory: RuntimeStorageFactory,
): Promise<RuntimeStorageHost> {
  let options: RuntimeStorageRegistrationOptions | undefined
  let active = true
  let installation: RuntimeStorageInstallation | undefined
  let result: RuntimeStorageInstallation
  try {
    result = await factory((value) => {
      if (!active || options) throw new Error("Runtime storage must register exactly once at boot")
      options = value
      installation = Object.freeze({ installationId: value.installationId })
      return installation
    })
  } catch (error) {
    await options?.close()
    throw error
  } finally {
    active = false
  }
  if (!options || result !== installation) {
    await options?.close()
    throw new Error("Unregistered runtime storage installation")
  }
  const backend = options
  let closed = false
  const host: RuntimeStorageHost = Object.freeze({
    installationId: backend.installationId,
    async close() {
      if (closed) return
      await backend.close()
      closed = true
      registrations.delete(host)
    },
  })
  registrations.set(host, backend)
  return host
}
/** Internal service import only; never exported from a CLI package entrypoint. */
export function runtimeStorageRegistration(
  host: RuntimeStorageHost,
): RuntimeStorageRegistrationOptions {
  const registration = registrations.get(host)
  if (!registration) throw new Error("Runtime storage host is closed or unrecognized")
  return registration
}
