import { config } from "@b4run/cli"
import { dockerSandbox, kubernetesSandbox } from "@b4run/sandbox"

const provider =
  process.env.B4_SMOKE_SANDBOX === "docker"
    ? dockerSandbox({
        image:
          "docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
      })
    : kubernetesSandbox({
        image:
          "docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
        namespace: "b4-sandboxes",
      })

export default config({
  appDir: "src/app",
  sandbox: {
    provider,
    network: { mode: "deny" },
  },
})
