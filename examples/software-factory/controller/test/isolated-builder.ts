import { fileURLToPath } from "node:url"
import { isolatedApp } from "./isolated-app.ts"

/** The BUILDER (`../../server/`) copied into a private installation; see `isolatedApp`. */
export const isolatedBuilder = (): Promise<string> =>
  isolatedApp(
    fileURLToPath(new URL("../../server/", import.meta.url)),
    "b4-software-factory-builder-",
  )
