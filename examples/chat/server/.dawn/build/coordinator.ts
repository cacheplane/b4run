import { fileURLToPath } from "node:url"
import { materializeResolvedRouteGraph } from "@dawn-ai/cli/runtime"

const appRoot = fileURLToPath(new URL("../..", import.meta.url))

export const graph = await materializeResolvedRouteGraph({
  appRoot,
  routeFile: fileURLToPath(new URL("../../src/app/coordinator/index.js", import.meta.url)),
  routeId: "/coordinator",
  routePath: "/coordinator",
})
