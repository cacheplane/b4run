/**
 * The events that record a capture handed to a worker, and the event that hands it to a
 * thread. Both spellings of the first: `*_manifest_written` (a manifest file) and
 * `*_source_staged` (an upload over the protocol), so a row journalled under either reads
 * the same.
 */
const ROLE = {
  builder: {
    written: ["builder_manifest_written", "builder_source_staged"],
    created: "thread_created",
  },
  drafter: {
    written: ["drafter_manifest_written", "drafter_source_staged"],
    created: "intake_thread_created",
  },
} as const

const DIGEST = /^[0-9a-f]{64}$/

/**
 * The source digest the controller handed to `threadId`: the last capture written before the
 * event that created that thread. A later capture whose thread creation failed is never the
 * answer, and neither is another thread's. The worker's read must report this digest
 * (`readThreadWorkspace`'s `expectedSourceDigest`), or the answer is about another workspace.
 *
 * Two threads handed the same source (a retry of the same task) share a digest, so this
 * refuses a worker answering with a different workspace, not every wrong thread; the thread
 * id in the path, its echo in the answer and the worker token are the rest.
 */
export function handedSourceDigest(
  events: readonly {
    readonly type: string
    readonly payload: Readonly<Record<string, unknown>>
  }[],
  threadId: string,
  role: keyof typeof ROLE,
): string {
  const { written, created } = ROLE[role]
  let last: unknown
  for (const event of events) {
    if ((written as readonly string[]).includes(event.type)) last = event.payload.sourceDigest
    else if (event.type === created && event.payload.threadId === threadId) {
      if (typeof last === "string" && DIGEST.test(last)) return last
      break
    }
  }
  throw new Error(
    `No ${role} source digest is journalled for thread ${threadId}: the controller cannot tell which workspace the worker must answer with`,
  )
}
