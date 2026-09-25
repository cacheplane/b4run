import { inject } from "vitest"
import { configureImages } from "../src/lib/targets/catalog.ts"
import { openLaneImages } from "./lane-images.ts"

configureImages(openLaneImages(inject("laneImagesDir")))
