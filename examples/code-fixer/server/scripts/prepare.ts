import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
execFileSync("docker", ["pull", "node:24-slim"], { stdio: "inherit" })
const base = JSON.parse(
  execFileSync("docker", ["image", "inspect", "node:24-slim"], { encoding: "utf8" }),
)[0].RepoDigests[0]
if (typeof base !== "string" || !/^node@sha256:[a-f0-9]{64}$/.test(base))
  throw new Error("Missing base image digest")
execFileSync(
  "docker",
  ["build", "--build-arg", `BASE_IMAGE=${base}`, "-t", "b4-code-fixer:fixture-v1", root],
  { stdio: "inherit" },
)
console.log(
  execFileSync("docker", ["image", "inspect", "b4-code-fixer:fixture-v1", "--format", "{{.Id}}"], {
    encoding: "utf8",
  }).trim(),
)
