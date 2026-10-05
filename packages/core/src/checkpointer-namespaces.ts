import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

/** A checkpointer that can enumerate a thread's namespaces (B4's SQLite and Postgres savers do). */
export interface NamespaceListingCheckpointer extends BaseCheckpointSaver {
  listNamespaces(threadId: string): Promise<readonly string[]>
}

export function canListNamespaces(
  saver: BaseCheckpointSaver,
): saver is NamespaceListingCheckpointer {
  return typeof (saver as { listNamespaces?: unknown }).listNamespaces === "function"
}
