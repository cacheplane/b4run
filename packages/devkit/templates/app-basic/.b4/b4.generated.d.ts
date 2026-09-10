/// <reference path="./scenarios.generated.d.ts" />

declare module "b4:routes" {
  export type B4RoutePath = "/hello/[tenant]";

  export interface B4RouteParams {
  "/hello/[tenant]": { tenant: string };
  }

  export interface B4RouteTools {
    "/hello/[tenant]": {
      readonly greet: (input: Parameters<typeof import("../src/app/(public)/hello/[tenant]/tools/greet.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/app/(public)/hello/[tenant]/tools/greet.js").default>>>;
    };
  }

  export type RouteTools<P extends B4RoutePath> = B4RouteTools[P];

  export interface B4RouteState {
    "/hello/[tenant]": {
      readonly context: string;
    };
  }

  export type RouteState<P extends B4RoutePath> = B4RouteState[P];
}
