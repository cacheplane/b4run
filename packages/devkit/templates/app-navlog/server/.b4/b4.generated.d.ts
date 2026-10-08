/// <reference path="./scenarios.generated.d.ts" />

declare module "b4:routes" {
  export type B4RoutePath = "/navlog" | "/navlog/subagents/performance" | "/navlog/subagents/weather";

  export interface B4RouteParams {
  "/navlog": {};
  "/navlog/subagents/performance": {};
  "/navlog/subagents/weather": {};
  }

  export interface B4RouteTools {
    "/navlog": {
      readonly computeNavlog: (input: Parameters<typeof import("../src/tools/computeNavlog.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/computeNavlog.js").default>>>;
      readonly fileFlightPlan: (input: Parameters<typeof import("../src/tools/fileFlightPlan.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/fileFlightPlan.js").default>>>;
      readonly getAdvisories: (input: Parameters<typeof import("../src/tools/getAdvisories.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getAdvisories.js").default>>>;
      readonly getMetar: (input: Parameters<typeof import("../src/tools/getMetar.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getMetar.js").default>>>;
      readonly getTaf: (input: Parameters<typeof import("../src/tools/getTaf.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getTaf.js").default>>>;
      readonly getWindsAloft: (input: Parameters<typeof import("../src/tools/getWindsAloft.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getWindsAloft.js").default>>>;
      readonly lookupAirport: (input: Parameters<typeof import("../src/tools/lookupAirport.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupAirport.js").default>>>;
      readonly readDoc: (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>;
      readonly renderChart: (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>;
      readonly resolveDeparture: (input: Parameters<typeof import("../src/tools/resolveDeparture.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/resolveDeparture.js").default>>>;
      readonly writeTodos: (input: { todos: ReadonlyArray<{ content: string; status: "pending" | "in_progress" | "completed" }> }) => Promise<{ todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }>;
      readonly readSkill: (input: { name: string }) => Promise<string>;
      readonly task: (input: { subagent: string; input: string }) => Promise<string>;
      readonly readFile: (input: { path: string; startLine?: number | null; endLine?: number | null }) => Promise<string>;
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>;
      readonly editFile: (input: { path: string; oldText: string; newText: string; replaceAll?: boolean | null }) => Promise<string>;
      readonly listDir: (input: { path?: string }) => Promise<string[]>;
      readonly runBash: (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      readonly remember: (input: { data: import("zod").infer<(typeof import("../src/app/navlog/memory").default)["schema"]>; content: string; tags?: string[]; confidence?: number }) => Promise<string>;
      readonly recall: (input: { query?: string; kind?: "semantic" | "episodic" | "procedural" | "reflection"; tags?: string[]; limit?: number; since?: string; until?: string }) => Promise<string>;
    };
    "/navlog/subagents/performance": {
      readonly computeNavlog: (input: Parameters<typeof import("../src/tools/computeNavlog.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/computeNavlog.js").default>>>;
      readonly fileFlightPlan: (input: Parameters<typeof import("../src/tools/fileFlightPlan.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/fileFlightPlan.js").default>>>;
      readonly getAdvisories: (input: Parameters<typeof import("../src/tools/getAdvisories.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getAdvisories.js").default>>>;
      readonly getMetar: (input: Parameters<typeof import("../src/tools/getMetar.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getMetar.js").default>>>;
      readonly getTaf: (input: Parameters<typeof import("../src/tools/getTaf.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getTaf.js").default>>>;
      readonly getWindsAloft: (input: Parameters<typeof import("../src/tools/getWindsAloft.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getWindsAloft.js").default>>>;
      readonly lookupAirport: (input: Parameters<typeof import("../src/tools/lookupAirport.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupAirport.js").default>>>;
      readonly readDoc: (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>;
      readonly renderChart: (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>;
      readonly resolveDeparture: (input: Parameters<typeof import("../src/tools/resolveDeparture.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/resolveDeparture.js").default>>>;
      readonly readFile: (input: { path: string; startLine?: number | null; endLine?: number | null }) => Promise<string>;
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>;
      readonly editFile: (input: { path: string; oldText: string; newText: string; replaceAll?: boolean | null }) => Promise<string>;
      readonly listDir: (input: { path?: string }) => Promise<string[]>;
      readonly runBash: (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    };
    "/navlog/subagents/weather": {
      readonly computeNavlog: (input: Parameters<typeof import("../src/tools/computeNavlog.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/computeNavlog.js").default>>>;
      readonly fileFlightPlan: (input: Parameters<typeof import("../src/tools/fileFlightPlan.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/fileFlightPlan.js").default>>>;
      readonly getAdvisories: (input: Parameters<typeof import("../src/tools/getAdvisories.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getAdvisories.js").default>>>;
      readonly getMetar: (input: Parameters<typeof import("../src/tools/getMetar.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getMetar.js").default>>>;
      readonly getTaf: (input: Parameters<typeof import("../src/tools/getTaf.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getTaf.js").default>>>;
      readonly getWindsAloft: (input: Parameters<typeof import("../src/tools/getWindsAloft.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/getWindsAloft.js").default>>>;
      readonly lookupAirport: (input: Parameters<typeof import("../src/tools/lookupAirport.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/lookupAirport.js").default>>>;
      readonly readDoc: (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>;
      readonly renderChart: (input: Parameters<typeof import("../src/tools/renderChart.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/renderChart.js").default>>>;
      readonly resolveDeparture: (input: Parameters<typeof import("../src/tools/resolveDeparture.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/resolveDeparture.js").default>>>;
      readonly readFile: (input: { path: string; startLine?: number | null; endLine?: number | null }) => Promise<string>;
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>;
      readonly editFile: (input: { path: string; oldText: string; newText: string; replaceAll?: boolean | null }) => Promise<string>;
      readonly listDir: (input: { path?: string }) => Promise<string[]>;
      readonly runBash: (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    };
  }

  export type RouteTools<P extends B4RoutePath> = B4RouteTools[P];

  export interface B4RouteState {
    "/navlog": {
      readonly context: string;
    };
  }

  export type RouteState<P extends B4RoutePath> = B4RouteState[P];
}
