import { fileURLToPath } from "node:url"
import base from "../../vitest.config.ts"

export default {
  ...base,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    ...base.test,
    include: ["test/fixtures/protocol-failed-teardown.ts"],
  },
}
