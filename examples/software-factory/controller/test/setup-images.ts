import { configureImages } from "../src/lib/targets/catalog.ts"
import { staticImageRegistry } from "./static-images.ts"

// Every unit test file starts with a registry that has an image of every recipe and no Docker.
configureImages(staticImageRegistry())
