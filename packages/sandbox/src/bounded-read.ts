function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Bound input before collecting transport output, retaining producer errors on POSIX sh. */
export async function readSandboxBytes(
  path: string,
  max: number | undefined,
  operation: "readFile" | "readBinaryFile",
  run: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<Buffer> {
  const bounded = max !== undefined && max !== Infinity
  if (bounded && (!Number.isSafeInteger(max) || max < 0 || max === Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid maxBytes limit")
  }
  // The extra byte distinguishes a file at the cap from a larger/growing file.
  // Frame head's exit status inside the encoded stream: POSIX sh has no pipefail.
  // No temporary spool can be grown by another process before encoding.
  const command = bounded
    ? `{ head -c ${max + 1} < ${q(path)}; b4_read_status=$?; printf '\\nB4_READ_STATUS_%s\\n' "$b4_read_status"; } | base64`
    : `base64 < ${q(path)}`
  const result = await run(command)
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.trim()}`)
  let bytes = Buffer.from(result.stdout.replace(/\s/g, ""), "base64")
  if (bounded) {
    const footer = /\nB4_READ_STATUS_(\d+)\n$/.exec(bytes.subarray(-40).toString("ascii"))
    if (footer?.[1] !== "0") {
      throw new Error(`${operation} failed: ${result.stderr.trim() || "invalid read status"}`)
    }
    bytes = bytes.subarray(0, bytes.length - footer[0].length)
    if (bytes.length > max)
      throw new Error(`${operation} ${path}: content exceeds maxBytes (${max}).`)
  }
  return bytes
}
