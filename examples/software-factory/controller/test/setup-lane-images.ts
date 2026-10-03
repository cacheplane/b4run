import { afterAll, inject } from "vitest"
import { configureImages } from "../src/lib/targets/catalog.ts"
import { openLaneImages } from "./lane-images.ts"

const registry = openLaneImages(inject("laneImagesDir"))
configureImages(registry)
afterAll(() => {
  configureImages(undefined)
  registry.close()
})
