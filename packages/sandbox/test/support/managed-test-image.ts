import { execFileSync } from "node:child_process"

/**
 * The image the managed-workspace Docker tests run: `B4_TEST_MANAGED_IMAGE`, or the
 * newest image `pnpm code-fixer:prepare` built for the `cli-flags` sample. Its tag
 * is content-addressed, so it is found by the label the preparation applies.
 */
export function managedTestImage(): string {
  const configured = process.env.B4_TEST_MANAGED_IMAGE
  if (configured) return configured
  const [newest] = execFileSync(
    "docker",
    [
      "image",
      "ls",
      "--filter",
      "label=org.b4run.code-fixer.project=cli-flags",
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line && !line.endsWith(":<none>"))
  if (!newest) throw new Error("No prepared code-fixer image: run pnpm code-fixer:prepare first")
  return newest
}
