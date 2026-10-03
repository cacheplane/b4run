/// <reference path="./scenarios.generated.d.ts" />

declare module "b4:routes" {
  export type B4RoutePath = "/hello";

  export interface B4RouteParams {
  "/hello": {};
  }

  export interface B4RouteTools {
    "/hello": {
      readonly greet: (input: Parameters<typeof import("../src/app/hello/tools/greet.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/app/hello/tools/greet.js").default>>>;
    };
  }

  export type RouteTools<P extends B4RoutePath> = B4RouteTools[P];
}
