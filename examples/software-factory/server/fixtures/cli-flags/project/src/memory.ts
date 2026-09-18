// Reduced handler: observable argument forwarding, no storage or model calls.
export async function runMemoryCommand(
  subcommand: string,
  args: string[],
  options: { cwd?: string },
) {
  let result: Record<string, unknown>
  if (subcommand === "consolidate" && args.length === 1 && args[0] === "--dry-run") {
    result = { action: "consolidate", dryRun: true }
  } else if (
    subcommand === "prune" &&
    args.length === 2 &&
    args[0] === "--cap" &&
    /^\d+$/.test(args[1] ?? "")
  ) {
    result = { action: "prune", cap: Number(args[1]) }
  } else {
    throw new Error("Invalid memory arguments")
  }
  if (options.cwd) result.cwd = options.cwd
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
