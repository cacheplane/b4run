/**
 * Where the thread rail gets its threads.
 *
 * B4.run's server can create and fetch a thread by id but cannot enumerate
 * threads — there is no list endpoint, and adding one is a thread-access
 * authorization question rather than a UI one. So the rail keeps its own list.
 *
 * CopilotKit's `useThreads` is deliberately unused: it fetches from a platform
 * with thread endpoints and folds "runtime without thread endpoints" into its
 * error channel, which is what a B4.run backend would produce.
 *
 * The planned second implementation is LangGraph Platform, which B4.run already
 * deploys to (`b4 build --target langsmith`) and which can enumerate threads.
 * `list`/`create` are synchronous today — LangGraph Platform will make those
 * async (or add a cached-read variant), and callers change with it.
 *
 * The conversation itself is not read through this seam: CopilotChat connects
 * the thread, and the runtime route restores it from B4.run's storage
 * (`createB4AgentRunner`), so the rail holds only ids, titles and recency.
 *
 * Known limitation: the localStorage backend below does read-modify-write with
 * no merge, so concurrent tabs can clobber each other's writes (e.g. a
 * `create()` in one tab can erase a `touch()` title from another).
 */
import { mediaParts, partsOf } from "./parts"

export interface WorkbenchThread {
  readonly id: string
  readonly title?: string
  readonly lastActiveAt: number
}

export interface ThreadSource {
  list(): WorkbenchThread[]
  create(): WorkbenchThread
  touch(id: string, firstUserMessage?: string): void
}

/**
 * A user message's displayable text. Multimodal content is an array of parts;
 * everything that is not a `text` part (an image, say) has no text to show, so
 * it contributes nothing rather than `[object Object]`.
 */
export function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return ""
      const candidate = part as { type?: unknown; text?: unknown }
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
    })
    .join("")
}

/**
 * A thread's rail title for a user message: its text, or — for a message that
 * is only media — what it carries, `(image)` say, so an image-only first turn
 * does not leave the thread untitled. The empty string means nothing to show.
 */
export function titleFor(content: unknown): string {
  const text = userText(content).trim()
  if (text.length > 0) return text
  const first = mediaParts(partsOf(content))[0]
  return first !== undefined ? `(${first.type})` : ""
}

const STORAGE_KEY = "b4.workbench.threads"
const MAX_TITLE_LENGTH = 80

function read(storage: Storage): WorkbenchThread[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is WorkbenchThread =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { lastActiveAt?: unknown }).lastActiveAt === "number",
    )
  } catch {
    // A corrupt or unavailable store costs the rail its history, never the run.
    return []
  }
}

function write(storage: Storage, threads: readonly WorkbenchThread[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(threads))
  } catch {
    // A failed write (e.g. private-mode quota) still leaves the mutator
    // returning/completing as if it persisted: the conversation is
    // unaffected, but the rail's in-memory state is now ahead of storage
    // and that history is what's lost.
  }
}

function byMostRecent(threads: readonly WorkbenchThread[]): WorkbenchThread[] {
  return [...threads].sort((left, right) => right.lastActiveAt - left.lastActiveAt)
}

export function createLocalThreadSource(storage: Storage): ThreadSource {
  return {
    list() {
      return byMostRecent(read(storage))
    },
    create() {
      const thread: WorkbenchThread = {
        id: globalThis.crypto.randomUUID(),
        lastActiveAt: Date.now(),
      }
      write(storage, [thread, ...read(storage)])
      return thread
    },
    touch(id, firstUserMessage) {
      const threads = read(storage)
      const existing = threads.find((thread) => thread.id === id)
      if (existing === undefined) return
      const title =
        existing.title ??
        (firstUserMessage === undefined || firstUserMessage.trim().length === 0
          ? undefined
          : firstUserMessage.trim().slice(0, MAX_TITLE_LENGTH))
      const updated: WorkbenchThread = {
        id,
        lastActiveAt: Date.now(),
        ...(title !== undefined ? { title } : {}),
      }
      write(storage, [updated, ...threads.filter((thread) => thread.id !== id)])
    },
  }
}
