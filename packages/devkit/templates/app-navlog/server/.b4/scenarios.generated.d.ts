import "@b4run/sdk/testing"

declare module "@b4run/sdk/testing" {
  interface RouteScenarioMap {
    "/navlog": {
      readonly tools: {
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "renderChart": (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>
        readonly "searchCorpus": (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>
      }
    }
    "/navlog/subagents/researcher": {
      readonly tools: {
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "renderChart": (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>
        readonly "searchCorpus": (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>
      }
    }
  }
}
