import type {
  RuntimeProviderTeardownPlan,
  RuntimeStorageFactory,
  RuntimeStorageInstallation,
  RuntimeStorageRegistrationOptions,
} from "@b4run/sdk/agent-protocol"

const registrations = new WeakMap<RuntimeStorageHost, RuntimeStorageRegistrationOptions>()
export type TemporaryCleanupPreparation = (context: {
  readonly installationId: string
  readonly threadId: string
  readonly generation: string
  readonly cleanupIntentId: string
}) => Promise<RuntimeProviderTeardownPlan>
const preparations = new WeakMap<RuntimeStorageHost, TemporaryCleanupPreparation>()
const closedAdmissions = new WeakSet<RuntimeStorageHost>()
export function closeRuntimeAdmission(host: RuntimeStorageHost): void {
  runtimeStorageRegistration(host)
  closedAdmissions.add(host)
}
export function runtimeAdmissionOpen(host: RuntimeStorageHost): boolean {
  runtimeStorageRegistration(host)
  return !closedAdmissions.has(host)
}
/** Boot-owned installation. Contains no caller scope, policy callback or store
 * accessor. HTTP bindings cannot install or replace its registration. */
export interface RuntimeStorageHost extends RuntimeStorageInstallation {
  close(): Promise<void>
}
export async function createRuntimeStorageHost(
  factory: RuntimeStorageFactory,
  hostOptions: { readonly prepareTemporaryCleanup?: TemporaryCleanupPreparation } = {},
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
      preparations.delete(host)
    },
  })
  registrations.set(host, backend)
  if (hostOptions.prepareTemporaryCleanup)
    preparations.set(host, hostOptions.prepareTemporaryCleanup)
  return host
}
/** Trusted boot readiness only; actual association facts are checked again by
 * native finalization. No request can register or replace this preparation. */
export function temporaryCleanupPreparation(
  host: RuntimeStorageHost,
): TemporaryCleanupPreparation | undefined {
  runtimeStorageRegistration(host)
  return preparations.get(host)
}
/** Internal service import only; never exported from a CLI package entrypoint. */
export function runtimeStorageRegistration(
  host: RuntimeStorageHost,
): RuntimeStorageRegistrationOptions {
  const registration = registrations.get(host)
  if (!registration) throw new Error("Runtime storage host is closed or unrecognized")
  return registration
}
