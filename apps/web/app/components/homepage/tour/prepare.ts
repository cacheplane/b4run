import "server-only"
import { preparePlayground } from "../playground/schema-variants"
import { prepareTourCode } from "./tour-sources"

/** Everything the folder tour renders, highlighted on the server. */
export async function prepareFolderTour() {
  const [code, variants] = await Promise.all([prepareTourCode(), preparePlayground()])
  return { code, variants }
}

export type FolderTourData = Awaited<ReturnType<typeof prepareFolderTour>>
