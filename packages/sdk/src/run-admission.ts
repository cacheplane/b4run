/** Request-scoped ownership of at most one thread's runtime writes. */
export interface RequestRunAdmission {
  /** Aborted when ownership is lost, fails, or is released. */
  readonly signal: AbortSignal
  /** Claim a thread, returning false while another request owns it. */
  tryAcquire(threadId: string): Promise<boolean>
  /** End ownership permanently; repeated calls await the same cleanup. */
  release(): Promise<void>
}
