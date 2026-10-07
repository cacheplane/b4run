// Ships the shared activity stylesheet as `@b4run/ag-ui-angular/styles.css`.
//
// A copy rather than a CSS `@import` of `@b4run/ag-ui/react/styles.css`: a
// copied file works with every bundler and with a plain `<link>`, while a
// bare-specifier `@import` is resolved differently (or not at all) by CSS
// toolchains. Both packages release together in one fixed version group, so
// the copy cannot fall behind the sheet it came from.
import { copyFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(import.meta.resolve("@b4run/ag-ui/react/styles.css"))
mkdirSync("dist", { recursive: true })
copyFileSync(source, "dist/styles.css")
