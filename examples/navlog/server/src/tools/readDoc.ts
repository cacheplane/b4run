import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"

const ROOTS = ["poh/", "regs/"]

function assertDocPath(path: string): void {
  if (!ROOTS.some((root) => path.startsWith(root)) || path.includes("..") || path.startsWith("/")) {
    throw new Error(`readDoc accepts workspace paths under ${ROOTS.join(" or ")}, got "${path}"`)
  }
}

/**
 * Read a POH table or regulation excerpt by its workspace path, e.g.
 * "poh/cruise-performance.md". Large documents are offloaded by B4.run and
 * retrieved on demand, so reading one does not flood the context.
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
