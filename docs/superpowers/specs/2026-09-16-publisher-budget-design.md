# Publisher budget alignment

The user approved a 60-minute publisher budget and 65-minute publish-npm job limit. Release 0.8.34 hit the existing 25-minute overall limit after 15 accepted packages, waited 15m48s to restart, then finished publishing in 9m34s. Earlier 0.8.32 needed 54m26s summed publisher-job time. These observations motivate bounded headroom; they do not prove a future speedup or guarantee every release completes in one attempt.

Change only PUBLISHER_OVERALL_TIMEOUT_MS in scripts/release/publisher.mjs from 25 to 60 minutes and publish-npm.timeout-minutes in .github/workflows/release.yml from 30 to 65. The existing subprocess runner already permits a 60-minute overall budget and receives this value from the publisher. Preserve its preparation default. The extra five minutes allow setup, evidence upload and cleanup; this remains a finite bound.

Preserve the ten-minute per-package propagation budget, five-minute npm command limit, serial package order, verification before advancing, OIDC, immutable artifacts, accepted-package reconciliation, and all existing cleanup/abort behavior. Add no jobs, gates, credentials, services, retries, command flags or publishing steps. A stalled whole publisher can now occupy its serialized queue longer; per-package and per-command failures still stop earlier.

Use deterministic injected clocks and deadline scheduling through the existing CLI seams. A full multi-package run with individual waits below ten minutes must finish after more than 25 minutes without duplicate publication. A run must still abort at sixty minutes and emit no successful evidence when expiry interrupts publication or verification. Retain existing real subprocess termination tests. Assert the production workflow budget and five-minute headroom together. Update reviewed release content pins and their digest only after source review.

Measure the next ordinary release whose candidate includes this commit; candidate-pinned publisher code means older tags do not inherit the new limit. Do not cut a release just to benchmark, rerun existing workflows, or claim the historical 2h55m49s incident timeline as a clean baseline. Discovery optimization and overlapping propagation waits remain separate follow-ups in #668.

## Required workflow recognition update

The existing preflight workflow policy fingerprints the complete execution descriptor, including this timeout. Retain the old reviewed-b4-postpublication-2026-09-12 variant and historical workflow fixture so managed older candidates remain recognizable. Add only the exact reviewed-b4-publisher-budget-2026-09-16 disabled variant and expected identifier for the new workflow. Test that both classify as disabled and their parsed workflows differ solely in publish-npm.timeout-minutes. Do not weaken canonicalization or topology validation. This is upkeep of the existing policy, not a publishing step or a new operator gate.
