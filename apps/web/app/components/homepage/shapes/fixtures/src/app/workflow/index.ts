import type { RuntimeContext, RuntimeTool } from "@b4run/sdk"

// Or use RouteTools from "b4:routes", which b4 typegen writes for you.
type Tools = {
  readonly greet: RuntimeTool<{ readonly name: string }, { readonly message: string }>
}

export async function workflow(input: { readonly name: string }, ctx: RuntimeContext<Tools>) {
  const name = input.name.trim()
  const { message } = await ctx.tools.greet({ name })
  return { message }
}
