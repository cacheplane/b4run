import { discoverRoutes } from "@b4run/core/node"

import { type CommandIo, formatErrorMessage, writeLine } from "../output.js"
import { runTypegen } from "./run-typegen.js"

/**
 * Regenerate `.b4/` typegen output (tool JSON schemas, state manifests, route
 * types) for an app before executing one of its routes in-process.
 *
 * The in-process runtime binds each tool's JSON schema from
 * `.b4/routes/<slug>/tools.json`. `b4 dev`, `b4 build`, and the
 * `@b4run/testing` harness (and so `b4 eval`) regenerate that file first, but
 * one-shot `b4 run` and `b4 test` did not: a tool added or changed since the
 * last `b4 typegen` was bound with a stale schema, or with none at all (a
 * permissive `Record<string, unknown>`), so the model guessed argument names
 * and the tool silently received `undefined` inputs.
 *
 * Best-effort, like `b4 dev`: a typegen failure (for example a tool whose
 * input type the compiler cannot resolve) is reported on stderr and the run
 * continues with whatever schemas are on disk, rather than failing a route
 * that may not even call the affected tool. stdout stays reserved for the
 * command's own output (`b4 run` prints its JSON result there).
 */
export async function refreshTypegenForRun(appRoot: string, io: CommandIo): Promise<void> {
  try {
    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })
  } catch (error) {
    writeLine(
      io.stderr,
      `Warning: could not regenerate tool schemas (${formatErrorMessage(error)}); ` +
        "tools may run with stale or missing schemas. Fix the error and run `b4 typegen`.",
    )
  }
}
