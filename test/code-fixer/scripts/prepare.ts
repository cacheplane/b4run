import { execFileSync } from "node:child_process"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureDirectory } from "../fixtures/catalog.js"

const root = await mkdtemp(join(tmpdir(), "b4-code-fixer-image-"))
try {
  const ids = ["cli-flags", "nullable-inputs"]
  for (const id of ids) {
    await cp(join(fixtureDirectory(id), "project"), join(root, id), { recursive: true })
  }
  execFileSync("docker", ["pull", "node:24-slim"], { stdio: "inherit" })
  const base = JSON.parse(
    execFileSync("docker", ["image", "inspect", "node:24-slim"], { encoding: "utf8" }),
  )[0].RepoDigests[0]
  if (typeof base !== "string" || !/^node@sha256:[a-f0-9]{64}$/.test(base))
    throw new Error("Missing base image digest")
  await writeFile(
    join(root, "Dockerfile"),
    [
      `FROM ${base}`,
      "RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*",
      ...ids.flatMap((id) => [
        `COPY ${id}/package*.json /opt/fixtures/${id}/`,
        `RUN npm ci --prefix /opt/fixtures/${id} --ignore-scripts --no-audit --no-fund`,
      ]),
      "USER node",
      "WORKDIR /workspace",
    ].join("\n"),
  )
  execFileSync("docker", ["build", "-t", "b4-code-fixer:fixture-v1", root], { stdio: "inherit" })
} finally {
  await rm(root, { recursive: true, force: true })
}
