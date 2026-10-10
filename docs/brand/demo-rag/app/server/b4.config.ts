import { config } from "@b4run/cli"
import { compose } from "@b4run/workspace"
import { localFilesystem } from "@b4run/workspace/node"
import { readOnlyPaths } from "./src/lib/read-only-paths.js"

export default config({
  appDir: "src/app",

  // The guidance excerpts and the plans are reference material: the agent can
  // read them but never change them.
  backends: {
    filesystem: compose(readOnlyPaths(["AGENTS.md", "fema/", "plans/"]))(localFilesystem()),
  },
  agentsMd: { writable: false },

  // The node target only: src/thread-access.ts makes threads visitor-owned.
  build: {
    targets: ["node"],
  },
})
