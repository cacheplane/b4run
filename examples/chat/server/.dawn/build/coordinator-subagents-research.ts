import { fileURLToPath } from "node:url"
import { materializeResolvedRouteGraph } from "@dawn-ai/cli/runtime"

const appRoot = fileURLToPath(new URL("../..", import.meta.url))

export const graph = await materializeResolvedRouteGraph({
  appRoot,
  routeFile: fileURLToPath(
    new URL("../../src/app/coordinator/subagents/research/index.js", import.meta.url),
  ),
  routeId: "/coordinator/subagents/research",
  routePath: "/coordinator/subagents/research",
})
