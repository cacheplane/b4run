import "@b4run/sdk/testing"

declare module "@b4run/sdk/testing" {
  interface RouteScenarioMap {
    "/research": {
      readonly tools: {
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "searchCorpus": (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>
      }
    }
    "/research/subagents/researcher": {
      readonly tools: {
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "searchCorpus": (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>
      }
    }
  }
}
