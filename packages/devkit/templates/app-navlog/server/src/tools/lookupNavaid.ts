import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { findNavaid, type Navaid } from "../lib/navaids.js"

/**
 * Look up a VOR, VORTAC or NDB by identifier: name, type, coordinates,
 * frequency and magnetic variation, from the bundled OurAirports snapshot.
 * A navaid enters computeNavlog with kind navaid and its own variation.
 */
export default async (input: { readonly id: string }, _ctx: B4ToolContext): Promise<Navaid> => {
  const id = input.id.trim().toUpperCase()
  const navaid = findNavaid(id)
  if (!navaid) throw new Error(`no navaid record for ${id}`)
  return navaid
}

export const display = {
  icon: "web",
  running: ({ id }) => `Looking up ${id.toUpperCase()}`,
  // The navaid's details in parentheses: two calls merge as "Looked up SNS and PYE".
  done: ({ id }, navaid) => `Looked up ${id.toUpperCase()} (${navaid.name} ${navaid.type})`,
} satisfies ToolDisplay<{ readonly id: string }, Navaid>
