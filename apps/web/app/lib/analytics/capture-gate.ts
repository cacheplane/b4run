const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(["b4.run", "www.b4.run"])

export interface CaptureGateInput {
  key: string | undefined
  host: string | undefined
  captureAnywhere: boolean
}

/**
 * Whether the browser should start sending product signals. Requires a
 * non-blank key, then either an explicit capture-anywhere opt-in or an exact
 * production host. A port only ever appears on non-production hosts, so a
 * host carrying one never matches.
 */
export function shouldCaptureSignals({ key, host, captureAnywhere }: CaptureGateInput): boolean {
  if (key === undefined || key.trim() === "") return false
  if (captureAnywhere) return true
  if (host === undefined) return false
  return PRODUCTION_HOSTS.has(host.trim().toLowerCase())
}
