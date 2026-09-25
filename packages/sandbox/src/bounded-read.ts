function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** The in-sandbox command for one bounded read: `max + 1` bytes plus an exit-status footer. */
export function boundedReadCommand(path: string, max: number): string {
  // The extra byte distinguishes a file at the cap from a larger/growing file.
  // Frame head's exit status inside the encoded stream: POSIX sh has no pipefail.
  // No temporary spool can be grown by another process before encoding.
  return `{ head -c ${max + 1} < ${q(path)}; b4_read_status=$?; printf '\\nB4_READ_STATUS_%s\\n' "$b4_read_status"; }`
}

/** Decode one {@link boundedReadCommand} result, already base64-decoded, into the file's bytes. */
export function decodeBoundedRead(
  framed: Buffer,
  path: string,
  max: number,
  operation: "readFile" | "readBinaryFile",
  stderr: string,
): Buffer {
  const footer = /\nB4_READ_STATUS_(\d+)\n$/.exec(framed.subarray(-40).toString("ascii"))
  if (footer?.[1] !== "0") {
    throw new Error(`${operation} failed: ${stderr.trim() || "invalid read status"}`)
  }
  const bytes = framed.subarray(0, framed.length - footer[0].length)
  if (bytes.length > max)
    throw new Error(`${operation} ${path}: content exceeds maxBytes (${max}).`)
  return bytes
}

export function validMaxBytes(max: number): void {
  if (!Number.isSafeInteger(max) || max < 0 || max === Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid maxBytes limit")
  }
}

/** Bound input before collecting transport output, retaining producer errors on POSIX sh. */
export async function readSandboxBytes(
  path: string,
  max: number | undefined,
  operation: "readFile" | "readBinaryFile",
  run: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<Buffer> {
  const bounded = max !== undefined && max !== Infinity
  if (bounded) validMaxBytes(max)
  const command = bounded ? `${boundedReadCommand(path, max)} | base64` : `base64 < ${q(path)}`
  const result = await run(command)
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.trim()}`)
  const bytes = Buffer.from(result.stdout.replace(/\s/g, ""), "base64")
  return bounded ? decodeBoundedRead(bytes, path, max, operation, result.stderr) : bytes
}
