import type { WorkspaceFs } from "@b4run/sdk"

import type { DiscoveredToolDefinition } from "./tool-shape.js"

export interface B4RouteContext {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly principal?: import("@b4run/sdk").B4Principal
  readonly signal: AbortSignal
  readonly tools: Record<string, (input: unknown) => Promise<unknown>>
  readonly fs: WorkspaceFs
}

export function createB4Context(options: {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly principal?: import("@b4run/sdk").B4Principal
  readonly signal?: AbortSignal
  readonly tools: readonly DiscoveredToolDefinition[]
  readonly fs: WorkspaceFs
}): B4RouteContext {
  const signal = options.signal ?? new AbortController().signal
  const middleware = options.middleware
  const principal = options.principal
  const tools = Object.fromEntries(
    options.tools.map((tool) => [
      tool.name,
      async (input: unknown) =>
        await tool.run(input, {
          ...(middleware ? { middleware } : {}),
          ...(principal ? { principal } : {}),
          signal,
          fs: options.fs,
        }),
    ]),
  )

  return {
    signal,
    tools,
    fs: options.fs,
    ...(middleware ? { middleware } : {}),
    ...(principal ? { principal } : {}),
  }
}
