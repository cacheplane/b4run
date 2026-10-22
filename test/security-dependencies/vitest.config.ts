import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export function securityTestIncludes(directory: string): string[] {
  const root = directory.replaceAll("\\", "/")
  return [`${root}/**/*.test.ts`, `${root}/**/*.test.tsx`]
}

export default defineConfig({
  root: resolve(rootDir, "../.."),
  test: {
    name: "dependency-security",
    environment: "node",
    env: {
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
    },
    fileParallelism: false,
    hookTimeout: 30_000,
    include: securityTestIncludes(rootDir),
    testTimeout: 30_000,
  },
})
