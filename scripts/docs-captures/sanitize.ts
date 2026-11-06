/** Defense in depth. Manual review is still required for every published asset. */
export function assertSafeText(text: string): void {
  if (
    /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+|\/(?:Users|home)\/[^/\s]+|(?:api[_-]?key|password|access_token|refresh_token|secret)\s*[=:]\s*(?!\[redacted\])\S+/i.test(
      text,
    )
  ) {
    throw new Error("Capture contains a secret or private path; make a clean recording")
  }
}
export function assertSafeValues(value: unknown): void {
  if (typeof value === "string") assertSafeText(value)
  else if (Array.isArray(value)) for (const child of value) assertSafeValues(child)
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(?:authorization|grant|api[_-]?key|token|id_token|access_token|refresh_token|password|secret)$/i.test(
          key,
        ) &&
        child !== "[redacted]"
      )
        throw new Error("Capture contains a structured secret")
      assertSafeValues(child)
    }
}
