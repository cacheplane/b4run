import type { B4ToolContext } from "@b4run/sdk"

// Tools may omit the context parameter when they need only their input.

type ToolFn<TInput = unknown, TOutput = unknown> = (input: TInput) => Promise<TOutput> | TOutput

const validBareToolUsage: ToolFn<
  { readonly tenant: string },
  { readonly greeting: string }
> = async (input) => ({ greeting: `Hello, ${input.tenant}!` })

void validBareToolUsage

function threadIdentity(ctx: B4ToolContext): string | undefined {
  return ctx.threadId
}

function contextWithoutThread(ctx: Omit<B4ToolContext, "threadId">): B4ToolContext {
  return ctx
}

function contextWithThread(ctx: B4ToolContext): B4ToolContext {
  return { ...ctx, threadId: "thread-123" }
}

function cannotReplaceThreadIdentity(ctx: B4ToolContext) {
  // @ts-expect-error Runtime identity is readonly to authored tools.
  ctx.threadId = "another-thread"
}

void threadIdentity
void contextWithoutThread
void contextWithThread
void cannotReplaceThreadIdentity
