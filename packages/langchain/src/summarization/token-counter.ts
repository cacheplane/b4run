import type { BaseMessage } from "@langchain/core/messages"
import { MEDIA_TOKEN_ESTIMATE, messageContentText } from "./message-text.js"

let encodeFn: ((text: string) => number[]) | undefined

/**
 * Default token counter. Lazily imports a single gpt-tokenizer encoding
 * (o200k_base — current OpenAI models) so apps that don't enable summarization
 * never load the large encoding tables. Async because of the lazy import.
 */
export async function defaultTokenCounter(text: string): Promise<number> {
  if (!encodeFn) {
    const mod = (await import("gpt-tokenizer/encoding/o200k_base")) as {
      encode: (t: string) => number[]
    }
    encodeFn = mod.encode
  }
  return encodeFn(text).length
}

function messageToText(m: BaseMessage): { text: string; mediaCount: number } {
  const content = messageContentText(m.content)
  const parts: string[] = [content.text]
  const toolCalls = (m as { tool_calls?: unknown }).tool_calls
  if (toolCalls) parts.push(JSON.stringify(toolCalls))
  return { text: parts.join("\n"), mediaCount: content.mediaCount }
}

/**
 * Sum a (possibly async) token counter across a message list. Media blocks are
 * counted as their placeholder text plus `MEDIA_TOKEN_ESTIMATE` each.
 */
export async function countMessagesTokens(
  messages: readonly BaseMessage[],
  counter: (text: string) => number | Promise<number>,
): Promise<number> {
  let total = 0
  for (const m of messages) {
    const { text, mediaCount } = messageToText(m)
    total += (await counter(text)) + mediaCount * MEDIA_TOKEN_ESTIMATE
  }
  return total
}
