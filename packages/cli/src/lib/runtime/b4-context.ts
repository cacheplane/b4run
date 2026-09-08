import type { WorkspaceFs } from "@b4run/sdk"

import type { DiscoveredToolDefinition } from "./tool-shape.js"

export interface B4RouteContext {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly tools: Record<string, (input: unknown) => Promise<unknown>>
  readonly fs: WorkspaceFs
}

export function createB4Context(options: {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
  readonly tools: readonly DiscoveredToolDefinition[]
  readonly fs: WorkspaceFs
}): B4RouteContext {
  const signal = options.signal ?? new AbortController().signal
  const middleware = options.middleware
  const tools = Object.fromEntries(
    options.tools.map((tool) => [
      tool.name,
      async (input: unknown) =>
        await tool.run(input, {
          ...(middleware ? { middleware } : {}),
          signal,
          fs: options.fs,
        }),
    ]),
  )

  const context: B4RouteContext = { signal, tools, fs: options.fs }
  if (middleware) {
    return { ...context, middleware }
  }
  return context
}
