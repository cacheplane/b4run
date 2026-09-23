import { fileURLToPath } from "node:url"
import { isolatedApp } from "./isolated-app.ts"

/** The DRAFTER (`../../drafter/`) copied into a private installation; see `isolatedApp`. */
export const isolatedDrafter = (): Promise<string> =>
  isolatedApp(
    fileURLToPath(new URL("../../drafter/", import.meta.url)),
    "b4-software-factory-drafter-",
  )
