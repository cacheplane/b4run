import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadStaticModules, serveRuntime } from "@dawn-ai/cli"

// server.mjs lives at <appRoot>/.dawn/build/server.mjs → appRoot is two dirs up
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

// modules.mjs statically imports the app's TypeScript sources, so it can't be
// a bare static import here — loadStaticModules registers the TS loader first,
// then imports the manifest through it. Boot performs no route-tree walk.
const modules = await loadStaticModules(new URL("./modules.mjs", import.meta.url))

await serveRuntime({ appRoot, modules })
