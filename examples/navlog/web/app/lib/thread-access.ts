/**
 * Whether the B4.run server will open a thread for this visitor, asked
 * through `GET /api/threads/<id>` (`app/api/threads/[id]/route.ts`).
 *
 * The sidebar's thread list lives in this browser's storage and the threads'
 * ownership in the visitor cookie, so the two can part: clear the cookie and
 * the list still names threads the server now refuses to the new visitor. A
 * refused thread would open as an empty chat (the runtime's replay treats its
 * 404 as nothing to restore) and fail on the first message, so the sidebar
 * asks before it trusts one, and forgets it when the answer is no.
 */

/** "open": the server serves it. "refused": it does not. "unknown": no answer either way. */
export type ThreadAccess = "open" | "refused" | "unknown"

/**
 * Asks once. Only a 404 counts as refused: a server error, a guard refusal
 * (rate limit, origin) or no connection says nothing about ownership, and a
 * thread is never forgotten on a guess.
 */
export async function checkThreadAccess(
  id: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreadAccess> {
  try {
    const response = await fetchImpl(`/api/threads/${encodeURIComponent(id)}`, {
      ...(signal !== undefined ? { signal } : {}),
    })
    if (response.ok) return "open"
    return response.status === 404 ? "refused" : "unknown"
  } catch {
    return "unknown"
  }
}
