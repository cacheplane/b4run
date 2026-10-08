import { defineThreadAccess, deny, permit, type ThreadAccessRequest } from "@b4run/sdk"

/**
 * This worker answers the factory's controller and nobody else. Every thread endpoint (create,
 * read, state, run, resume, cancel, delete, the workspace read and the source upload) requires
 * the controller principal `src/auth.ts` resolves from the worker token; anything else is 403.
 *
 * Staged workspaces (`sandbox.stagedWorkspaces`): an upload the controller makes is stamped
 * `{ principal: "controller" }`, and a create naming a workspace is admitted only when that
 * source was uploaded under that stamp (`requestedWorkspace.uploadedBy`). With one caller the
 * rule is defence in depth, not a second identity: it pins, by test, that a thread's workspace
 * is always one the controller itself uploaded, never a source this worker holds for another
 * reason.
 *
 * Deliberately a copy in each worker app, pinned equal by `controller/test/worker-token.test.ts`.
 */

/** The stamp every upload the controller makes carries: the one uploader this worker knows. */
const CONTROLLER_UPLOADER = "controller"

/** Whether the controller uploaded the named source: an `uploadedBy` stamp that is exactly its own. */
export function uploadedByController(
  workspace: NonNullable<ThreadAccessRequest["requestedWorkspace"]>,
): boolean {
  return (workspace.uploadedBy ?? []).some(
    (stamp) => Object.keys(stamp).length === 1 && stamp.principal === CONTROLLER_UPLOADER,
  )
}

export default defineThreadAccess({
  fallback: (request) => {
    if (request.principal?.id !== "controller") return deny({ status: 403 })
    // An upload is not yet any thread's: its stamp is its uploader, kept with the source.
    if (request.operation === "workspace.source.put")
      return permit({ principal: CONTROLLER_UPLOADER })
    if (
      request.requestedWorkspace !== undefined &&
      !uploadedByController(request.requestedWorkspace)
    )
      return deny({
        status: 403,
        body: {
          error: {
            message:
              "The named workspace source was not uploaded by the controller, or is no longer held: upload it first",
            details: { code: "workspace_not_uploaded_by_controller" },
          },
        },
      })
    return permit()
  },
})
