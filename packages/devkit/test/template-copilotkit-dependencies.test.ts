import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

interface WebManifest {
  readonly dependencies?: Readonly<Record<string, string>>
}

const manifestPath = fileURLToPath(
  new URL("../templates/app-navlog/web/package.json.template", import.meta.url),
)

describe("navlog web template dependency alignment", () => {
  it("generates a CopilotKit v2 app on the reviewed AG-UI dependency family", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WebManifest

    expect(manifest.dependencies).toMatchObject({
      "@ag-ui/client": "1.0.2",
      "@copilotkit/react-core": "1.77.1",
      "@copilotkit/runtime": "1.77.1",
    })
  })
})
