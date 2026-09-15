# Release discovery failure detail

The user authorized exposing the hidden discovery exception and resolving the
release blocker, continuing the PR/merge-on-green workflow. Preserve publishing
order, deadlines, authorization decisions, and workflow topology.

The saved reports for runs 35027811771 and 35031718037 contain only
CANDIDATE_DISCOVERY_AMBIGUOUS. In cli.mjs the discovery catch converts an Error
into a code-only record, so the already-tested safeDetail formatter used by the
CLI's top-level failure handler never runs. The artifact identifies the stage
but cannot explain the failure. This observability defect is reproduced by
injecting a discovery Error with a controlled message into the real observe CLI.

Add a detail string to the candidate-discovery failure diagnostic in the saved
report, using the existing safeDetail formatter. Keep code, classification,
blocked disposition, proposed mutations, and workflow outputs unchanged. Details
are for operators only and must never authorize a transition. Reuse existing
512-character limit, control-character cleanup, bounded cause chain, and known
credential/URL-query redaction. Do not log stack traces or raw response bodies.
No new dependency, callback, service, command, or workflow step is needed.

Tests cover a plain discovery Error, recognized credential shapes and signed
URLs, hostile message getters, exact bound, report persistence, and unchanged
blocked/no-write behavior. Full production replay remains a separate diagnostic:
the current evidence does not yet establish the underlying CI exception.
