import { pathToFileURL } from "node:url"

import type { DescriptorRouteIndex, RouteManifest } from "@b4run/core"
import { type B4Agent, isB4Agent } from "@b4run/sdk"

let descriptorRouteIndexCache = new WeakMap<RouteManifest, Promise<DescriptorRouteIndex>>()

export async function buildDescriptorRouteIndex(
  manifest: RouteManifest,
): Promise<DescriptorRouteIndex> {
  const imported = await Promise.all(
    manifest.routes.map(async (route) => {
      try {
        const mod = (await import(pathToFileURL(route.entryFile).href)) as { default?: unknown }
        return isB4Agent(mod.default) ? ([mod.default, route.id] as const) : undefined
      } catch {
        return undefined
      }
    }),
  )

  const mutable = new Map<B4Agent, string[]>()
  for (const entry of imported) {
    if (!entry) continue
    const [descriptor, routeId] = entry
    mutable.set(descriptor, [...(mutable.get(descriptor) ?? []), routeId])
  }

  return new Map(
    [...mutable].map(([descriptor, routeIds]) => [descriptor, routeIds.sort()] as const),
  )
}

export async function getCachedDescriptorRouteIndex(
  manifest: RouteManifest,
): Promise<DescriptorRouteIndex> {
  let promise = descriptorRouteIndexCache.get(manifest)
  if (!promise) {
    promise = buildDescriptorRouteIndex(manifest)
    descriptorRouteIndexCache.set(manifest, promise)
  }
  return promise
}

export function __resetDescriptorRouteIndexCacheForTests(): void {
  descriptorRouteIndexCache = new WeakMap()
}
