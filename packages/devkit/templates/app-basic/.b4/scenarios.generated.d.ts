import "@b4run/sdk/testing"

declare module "@b4run/sdk/testing" {
  interface RouteScenarioMap {
    "/hello": {
      readonly tools: {
        readonly "greet": (input: Parameters<typeof import("../src/app/hello/tools/greet.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/app/hello/tools/greet.js").default>>>
      }
    }
  }
}
