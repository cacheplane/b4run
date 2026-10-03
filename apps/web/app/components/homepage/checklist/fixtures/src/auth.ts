export interface Principal {
  readonly id: string
}

/** Resolve the caller from a trusted header. Replace it with your token check. */
export async function principalOf(
  headers: Readonly<Record<string, string>>,
): Promise<Principal | undefined> {
  const id = headers["x-user-id"]
  return id === undefined ? undefined : { id }
}
