import "@dawn-ai/sdk/testing"

declare module "@dawn-ai/sdk/testing" {
  interface RouteScenarioMap {
    "/chat": {
      readonly tools: Record<never, never>
    }
    "/coordinator": {
      readonly tools: Record<never, never>
    }
    "/coordinator/subagents/research": {
      readonly tools: Record<never, never>
    }
    "/coordinator/subagents/summarizer": {
      readonly tools: Record<never, never>
    }
  }
}
