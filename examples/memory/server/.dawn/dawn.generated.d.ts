/// <reference path="./scenarios.generated.d.ts" />

declare module "dawn:routes" {
  export type DawnRoutePath = "/notes"

  export interface DawnRouteParams {
    "/notes": {}
  }

  export interface DawnRouteTools {
    "/notes": {
      readonly remember: (input: {
        data: import("zod").infer<typeof import("../src/app/notes/memory").default["schema"]>
        content: string
        tags?: string[]
        confidence?: number
      }) => Promise<string>
      readonly recall: (input: {
        query?: string
        kind?: "semantic" | "episodic" | "procedural" | "reflection"
        tags?: string[]
        limit?: number
        since?: string
        until?: string
      }) => Promise<string>
    }
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P]
}
