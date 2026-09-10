/**
 * The NODE flavour of the runtime registry: the pure core plus the disk-first
 * default — walk the route tree with `discoverRoutes` when the caller has no
 * prebuilt `B4StaticModules`. Deliberately absent from the
 * `@b4run/cli/fetch` graph (see `runtime-registry-core.ts`).
 */

import { discoverRoutes } from "@b4run/core/node"

import type { B4StaticModules } from "../runtime/static-modules-core.js"
import {
  createRuntimeRegistryFromManifest,
  createStaticRuntimeRegistry,
  type RuntimeRegistry,
  type RuntimeRegistryEntry,
} from "./runtime-registry-core.js"

export type { RuntimeRegistry, RuntimeRegistryEntry }

export async function createRuntimeRegistry(
  appRoot: string,
  modules?: B4StaticModules,
): Promise<RuntimeRegistry> {
  if (modules) {
    return createStaticRuntimeRegistry(appRoot, modules)
  }

  return createRuntimeRegistryFromManifest(await discoverRoutes({ appRoot }))
}
