# Fresh npm signature-audit metadata

0.10.0 took 1h42m32s from merge to publication. Its publisher took 58m53s,
and three packages each emitted 28 ETARGET audit retries, around five minutes
apiece. The audit verifier reuses a private npm cache without requesting
revalidation. A controlled localhost registry with npm 11.17.0's actual pacote
reproduced ETARGET after the version became available with no network request;
preferOnline caused a fresh request and returned the correct version.
Historical logs do not retain cache headers, so exact historical attribution
and production time savings remain unproven.

Set npm_config_prefer_online=true in the isolated audit environment only,
using its existing additionalEnvironment mechanism. Keep the publisher environment,
registry adapter, audit arguments, retry classification, provenance/signature
validation, deadlines, serial package order, and workflows unchanged. Strip
ambient offline/prefer-offline settings as already done by the allowlist. Keep
the cache for revalidated metadata and verification material; do not delete it.

Alternatives: clearing the cache discards useful material and needs more lifecycle
handling; increasing deadlines masks repeated work; overlapping publication changes
release behavior. None is needed for this fix.

Verify configuration isolation, ambient override resistance, pending-to-verified
retry behavior, unchanged publisher environment, existing audit failures and
integrity pins. Document the exact npm 11.17.0 reproduction and 0.10.0 phase
measurements. Full controller and hosted CI must pass; merge normally and monitor.
No benchmark release. Measure actual savings on the next ordinary release.
