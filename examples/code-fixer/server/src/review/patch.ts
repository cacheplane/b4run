import type { SandboxHandle } from "@b4run/workspace"
import { z } from "zod"

export class PatchRejectedError extends Error {
  override name = "PatchRejectedError"
}

export function collectChanges(
  baseline: Record<string, string>,
  target: Record<string, string>,
  allowed: readonly string[],
): Record<string, string> {
  if (JSON.stringify(Object.keys(baseline).sort()) !== JSON.stringify(Object.keys(target).sort()))
    throw new PatchRejectedError(
      `Changed file inventory: added ${Object.keys(target)
        .filter((p) => !Object.hasOwn(baseline, p))
        .join(", ")}; removed ${Object.keys(baseline)
        .filter((p) => !Object.hasOwn(target, p))
        .join(", ")}`,
    )
  const changes: Record<string, string> = {}
  let bytes = 0
  for (const [path, value] of Object.entries(target)) {
    if (value === baseline[path]) continue
    if (!allowed.includes(path)) throw new PatchRejectedError(`Immutable file changed: ${path}`)
    bytes += Buffer.byteLength(value)
    if (bytes > 1024 * 1024) throw new PatchRejectedError("Patch exceeds 1 MiB")
    changes[path] = value
  }
  return changes
}

// This program is supplied by the host and uses only Node built-ins. Never
// load a snapshot helper, test runner, or Git configuration from the target.
const snapshotProgram = `
const fs = require('node:fs');
const result = Object.create(null); let total = 0; let entries = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir || '.', {withFileTypes:true})) {
    if (!dir && item.name === 'node_modules@link') throw Error('reserved snapshot metadata path');
    if (!dir && item.name === '.git') continue;
    if (!dir && item.name === 'node_modules') {
      if (!item.isSymbolicLink()) throw Error('node_modules must be a prepared dependency link');
      const target = fs.readlinkSync('node_modules');
      if (!/^\\/opt\\/fixtures\\/[a-z-]+\\/node_modules$/.test(target)) throw Error('unexpected dependency link');
      result['node_modules@link'] = target;
      continue;
    }
    const path = dir ? dir+'/'+item.name : item.name;
    if (++entries > 1000) throw Error('too many entries');
    if (item.isSymbolicLink()) throw Error('symlink: '+path);
    if (item.isDirectory()) { walk(path); continue; }
    if (!item.isFile()) throw Error('not a file: '+path);
    const stat = fs.lstatSync(path); total += stat.size;
    if (total > 2*1024*1024) throw Error('snapshot too large');
    const buffer = fs.readFileSync(path);
    if (buffer.includes(0)) throw Error('binary file: '+path);
    const text = new TextDecoder('utf-8',{fatal:true}).decode(buffer);
    result[path] = text;
  }
}
walk(''); process.stdout.write(JSON.stringify(result));`

export async function snapshot(
  handle: SandboxHandle,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const quoted = `'${snapshotProgram.replace(/'/g, "'\\''")}'`
  const result = await handle.exec.runCommand(
    { command: `/usr/local/bin/node -e ${quoted}` },
    { workspaceRoot: handle.workspaceRoot, signal },
  )
  if (result.exitCode !== 0) throw new Error(`Snapshot failed: ${result.stderr}`)
  return z.record(z.string(), z.string()).parse(JSON.parse(result.stdout))
}

/** A complete-file unified diff built from host-validated bytes. */
export function renderReviewDiff(
  baseline: Record<string, string>,
  changes: Record<string, string>,
): string {
  return Object.keys(changes)
    .sort()
    .map((path) => {
      const before = baseline[path]
      const after = changes[path]
      if (before === undefined || after === undefined)
        throw new PatchRejectedError("Missing review source")
      const lines = (value: string) => (value === "" ? [] : value.replace(/\n$/, "").split("\n"))
      const oldLines = lines(before)
      const newLines = lines(after)
      const section = (value: string, items: string[], prefix: string) =>
        items
          .map(
            (line, index) =>
              `${prefix}${line}\n${index === items.length - 1 && !value.endsWith("\n") ? "\\ No newline at end of file\n" : ""}`,
          )
          .join("")
      return `--- a/${path}\n+++ b/${path}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${section(before, oldLines, "-")}${section(after, newLines, "+")}`
    })
    .join("")
}
