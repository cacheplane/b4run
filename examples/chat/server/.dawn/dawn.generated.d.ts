/// <reference path="./scenarios.generated.d.ts" />

declare module "dawn:routes" {
  export type DawnRoutePath =
    | "/chat"
    | "/coordinator"
    | "/coordinator/subagents/research"
    | "/coordinator/subagents/summarizer"

  export interface DawnRouteParams {
    "/chat": {}
    "/coordinator": {}
    "/coordinator/subagents/research": {}
    "/coordinator/subagents/summarizer": {}
  }

  export interface DawnRouteTools {
    "/chat": {
      readonly writeTodos: (input: {
        todos: ReadonlyArray<{ content: string; status: "pending" | "in_progress" | "completed" }>
      }) => Promise<{
        todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>
      }>
      readonly readSkill: (input: { name: string }) => Promise<string>
      readonly readFile: (input: { path: string }) => Promise<string>
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>
      readonly listDir: (input: { path?: string }) => Promise<string[]>
      readonly runBash: (input: {
        command: string
      }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    }
    "/coordinator": {
      readonly task: (input: { subagent: string; input: string }) => Promise<string>
      readonly readFile: (input: { path: string }) => Promise<string>
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>
      readonly listDir: (input: { path?: string }) => Promise<string[]>
      readonly runBash: (input: {
        command: string
      }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    }
    "/coordinator/subagents/research": {
      readonly readFile: (input: { path: string }) => Promise<string>
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>
      readonly listDir: (input: { path?: string }) => Promise<string[]>
      readonly runBash: (input: {
        command: string
      }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    }
    "/coordinator/subagents/summarizer": {
      readonly readFile: (input: { path: string }) => Promise<string>
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>
      readonly listDir: (input: { path?: string }) => Promise<string[]>
      readonly runBash: (input: {
        command: string
      }) => Promise<{ stdout: string; stderr: string; exitCode: number }>
    }
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P]

  export interface DawnRouteState {
    "/chat": {}
  }

  export type RouteState<P extends DawnRoutePath> = DawnRouteState[P]
}
