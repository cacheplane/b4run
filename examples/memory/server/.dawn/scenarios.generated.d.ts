import "@dawn-ai/sdk/testing"

declare module "@dawn-ai/sdk/testing" {
  interface RouteScenarioMap {
    "/notes": {
      readonly tools: Record<never, never>
    }
  }
}
