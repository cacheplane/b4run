import type { PromptFragment } from "@b4run/core"

/**
 * Renders the system prompt for one model turn: the route's prompt followed by
 * every non-empty `after_user_prompt` fragment, each rendered from live state.
 */
export async function composeSystemPrompt(
  systemPrompt: string,
  promptFragments: readonly PromptFragment[],
  state: Record<string, unknown>,
): Promise<string> {
  const rendered = (
    await Promise.all(
      promptFragments
        .filter((f) => f.placement === "after_user_prompt")
        .map((f) => (f.renderAsync ? f.renderAsync(state) : f.render(state))),
    )
  ).filter((s) => s.length > 0)
  return [systemPrompt, ...rendered].join("\n\n")
}
