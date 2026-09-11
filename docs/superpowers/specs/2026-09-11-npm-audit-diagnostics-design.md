# npm audit diagnostics and transient failures

The user approved reducing release restarts without new workflows, gates, receipts, timeouts, manual steps or token fallback. The two historical audit-root failures remain unexplained because their original responses were lost; this change must not relabel them as known network failures.

Pinned npm 11.17.0 source and local constructor probes establish the exact error envelope `{error:{code,summary,detail}}` with exit code 1 for HTTP and selected transport errors. Normal complete verified audit output must have exit code 0. Existing code accepts command exits 0 and 1 but discards that distinction.

Classify the full npm command result in the existing audit adapter. A finite allowlist of ETIMEDOUT, ECONNRESET, EAI_AGAIN, E429, E500, E502, E503 and E504 may produce the existing exact `{status:"pending"}` result for single-package verification, only with exit 1 and an exact error-only envelope whose required fields have valid types. The publisher's existing convergence clock/poll loop owns all retries. No new timer, runner retry or broadened accepted exit codes.

E404, auth failures, unknown codes/shapes, mixed error/evidence, malformed JSON, missing/invalid signatures, successful evidence with exit 1 and transient envelopes with exit 0 remain fatal. Preserve complete batch verification: batch errors gain safe diagnostics but still reject because batch callers have no pending protocol. Never fabricate pending rows or reuse earlier proof.

Safe diagnostics use only fixed classification labels, validated exit code, an allowlisted npm error code, bounded byte counts, and a recognized root-shape label. Do not expose summary/detail, arbitrary keys, URLs, raw stdout/stderr, parser causes or credentials. Diagnostics go to existing logs; no new mandatory artifact. Process-runner timeout, abort, spawn, signal and output-limit failures retain their existing fatal behavior.

Test complete exit/output matrix, secret-marker non-disclosure for single and batch, single transient-to-verified and deadline exhaustion/abort in the actual publisher loop, fatal errors causing zero polls, fresh batch capture/tree checks/cleanup. Update content pins for any edited release-reachable module. Preserve package order, OIDC identity, immutable artifacts and all verification requirements.

Independent review passed with explicit boundaries: the publisher's final complete verification sweep has no pending loop, so transient failure there remains fatal and must have a regression. Test each allowlisted code, all malformed/absent/noninteger exit statuses and invalid envelope field types. Sanitize adapter-facing errors too: existing parser causes and invalid-evidence names can contain untrusted text; no such nested cause or name may escape through existing CLI logs. Exported low-level parsers may retain their diagnostic contracts if all production adapter boundaries contain their output safely.
