import "@b4run/sdk/testing"

declare module "@b4run/sdk/testing" {
  interface RouteScenarioMap {
    "/navlog": {
      readonly tools: {
        readonly "computeNavlog": (input: Parameters<typeof import("../src/tools/computeNavlog.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/computeNavlog.js").default>>>
        readonly "fileFlightPlan": (input: Parameters<typeof import("../src/tools/fileFlightPlan.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/fileFlightPlan.js").default>>>
        readonly "findRouteStations": (input: Parameters<typeof import("../src/tools/findRouteStations.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/findRouteStations.js").default>>>
        readonly "getAdvisories": (input: Parameters<typeof import("../src/tools/getAdvisories.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getAdvisories.js").default>>>
        readonly "getMetar": (input: Parameters<typeof import("../src/tools/getMetar.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getMetar.js").default>>>
        readonly "getTaf": (input: Parameters<typeof import("../src/tools/getTaf.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getTaf.js").default>>>
        readonly "getWindsAloft": (input: Parameters<typeof import("../src/tools/getWindsAloft.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getWindsAloft.js").default>>>
        readonly "lookupAirport": (input: Parameters<typeof import("../src/tools/lookupAirport.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupAirport.js").default>>>
        readonly "lookupNavaid": (input: Parameters<typeof import("../src/tools/lookupNavaid.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupNavaid.js").default>>>
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "renderChart": (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>
        readonly "resolveDeparture": (input: Parameters<typeof import("../src/tools/resolveDeparture.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/resolveDeparture.js").default>>>
      }
    }
    "/navlog/subagents/performance": {
      readonly tools: {
        readonly "computeNavlog": (input: Parameters<typeof import("../src/tools/computeNavlog.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/computeNavlog.js").default>>>
        readonly "fileFlightPlan": (input: Parameters<typeof import("../src/tools/fileFlightPlan.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/fileFlightPlan.js").default>>>
        readonly "findRouteStations": (input: Parameters<typeof import("../src/tools/findRouteStations.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/findRouteStations.js").default>>>
        readonly "getAdvisories": (input: Parameters<typeof import("../src/tools/getAdvisories.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getAdvisories.js").default>>>
        readonly "getMetar": (input: Parameters<typeof import("../src/tools/getMetar.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getMetar.js").default>>>
        readonly "getTaf": (input: Parameters<typeof import("../src/tools/getTaf.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getTaf.js").default>>>
        readonly "getWindsAloft": (input: Parameters<typeof import("../src/tools/getWindsAloft.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getWindsAloft.js").default>>>
        readonly "lookupAirport": (input: Parameters<typeof import("../src/tools/lookupAirport.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupAirport.js").default>>>
        readonly "lookupNavaid": (input: Parameters<typeof import("../src/tools/lookupNavaid.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupNavaid.js").default>>>
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "renderChart": (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>
        readonly "resolveDeparture": (input: Parameters<typeof import("../src/tools/resolveDeparture.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/resolveDeparture.js").default>>>
      }
    }
    "/navlog/subagents/weather": {
      readonly tools: {
        readonly "computeNavlog": (input: Parameters<typeof import("../src/tools/computeNavlog.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/computeNavlog.js").default>>>
        readonly "fileFlightPlan": (input: Parameters<typeof import("../src/tools/fileFlightPlan.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/fileFlightPlan.js").default>>>
        readonly "findRouteStations": (input: Parameters<typeof import("../src/tools/findRouteStations.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/findRouteStations.js").default>>>
        readonly "getAdvisories": (input: Parameters<typeof import("../src/tools/getAdvisories.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getAdvisories.js").default>>>
        readonly "getMetar": (input: Parameters<typeof import("../src/tools/getMetar.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getMetar.js").default>>>
        readonly "getTaf": (input: Parameters<typeof import("../src/tools/getTaf.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getTaf.js").default>>>
        readonly "getWindsAloft": (input: Parameters<typeof import("../src/tools/getWindsAloft.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getWindsAloft.js").default>>>
        readonly "lookupAirport": (input: Parameters<typeof import("../src/tools/lookupAirport.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupAirport.js").default>>>
        readonly "lookupNavaid": (input: Parameters<typeof import("../src/tools/lookupNavaid.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupNavaid.js").default>>>
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "renderChart": (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>
        readonly "resolveDeparture": (input: Parameters<typeof import("../src/tools/resolveDeparture.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/resolveDeparture.js").default>>>
      }
    }
  }
}
