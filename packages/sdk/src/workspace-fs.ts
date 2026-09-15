/**
 * Sandboxed filesystem handle scoped to the route's workspace/ directory.
 *
 * Relative paths resolve against the workspace root. Every call is
 * permission-gated with the same rules as the agent-facing workspace tools:
 * paths inside workspace/ are always allowed; paths outside consult the
 * permissions store (interactive prompt where available, fail-closed
 * otherwise).
 */
export interface WorkspaceFs {
  /** Inspect the leaf entry without following its symlink; uses read permissions. */
  stat?(path: string): Promise<{
    readonly kind: "file" | "directory" | "symlink" | "other"
    readonly size: number
    readonly executable: boolean
    readonly target?: string
  }>
  /** Read a UTF-8 file. */
  readFile(path: string, opts?: { readonly maxBytes?: number }): Promise<string>
  /**
   * Read raw bytes (images, PDFs, …). Throws a descriptive error when the
   * configured filesystem backend does not implement binary reads.
   */
  readBinaryFile(path: string, opts?: { readonly maxBytes?: number }): Promise<Uint8Array>
  /** Write a UTF-8 file. localFilesystem creates missing parent directories. */
  writeFile(path: string, content: string): Promise<{ readonly bytesWritten: number }>
  /** List entries (leaf names). Defaults to the workspace root. */
  listDir(path?: string): Promise<readonly string[]>
}

/** Trusted provenance of the managed workspace admitted for this invocation. */
export interface WorkspaceContext {
  readonly id: string
  readonly sourceDigest: string
  readonly environment: {
    readonly binding: {
      readonly provider: string
      readonly scope: string
      readonly account: string
    }
    readonly identity: string
  }
  readonly baselineCommit?: string
  /** Read original captured bytes using the workspace read permission policy. */
  readInitialFile(path: string): Promise<Uint8Array>
}

/** The context argument B4.run passes to a route tool's function. */
export interface B4ToolContext {
  readonly signal: AbortSignal
  /**
   * Conversation thread identity supplied by the runtime when available.
   * Not an authenticated principal, authorization decision, or globally scoped
   * sandbox resource identifier. May be absent outside a threaded invocation.
   */
  readonly threadId?: string
  readonly workspace?: WorkspaceContext
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly fs: WorkspaceFs
}
