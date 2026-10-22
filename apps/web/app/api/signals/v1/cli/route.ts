import { after } from "next/server"
import { createCliSignalsHandler } from "../../../../lib/signals/cli-ingest"

/** Anonymous `b4` CLI usage signals. Contract: `docs/growth/README.md`, "CLI signals". */
export const POST = createCliSignalsHandler({ schedule: after })
