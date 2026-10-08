import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"

const ROOTS = ["aircraft/", "poh/", "regs/", "tool-outputs/"]

function assertDocPath(path: string): void {
  if (!ROOTS.some((root) => path.startsWith(root)) || path.includes("..") || path.startsWith("/")) {
    throw new Error(`readDoc accepts workspace paths under ${ROOTS.join(", ")}, got "${path}"`)
  }
}

/**
 * Read the aircraft baseline, a POH table or a regulation excerpt by its
 * workspace path, e.g. "aircraft/c172n.md" or "poh/cruise-performance.md", or
 * an offloaded tool output named by a "Full output saved to: tool-outputs/..." stub.
 */
export default async (input: { readonly path: string }, ctx: B4ToolContext) => {
  assertDocPath(input.path)
  const content = await ctx.fs.readFile(input.path)
  return { content }
}

export const display = {
  icon: "read",
  running: ({ path }) => `Reading ${path}`,
  done: ({ path }) => `Read ${path}`,
  sources: () => [],
} satisfies ToolDisplay<{ readonly path: string }, { readonly content: string }>
