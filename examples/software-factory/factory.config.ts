import type { FactoryUpConfig } from "./controller/src/lib/operator/factory-config.ts"

// `pnpm factory up` starts the controller, the builder and the drafter on these ports, on
// 127.0.0.1 only; `pnpm factory run` and every other `factory` command read the controller's
// URL and the state directory from here. Validated strictly at load: an unknown key refuses.
export default {
  state: ".factory",
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
} satisfies FactoryUpConfig
