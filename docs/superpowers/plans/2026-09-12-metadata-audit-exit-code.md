# Metadata audit exit-code repair

1. Reproduce the missing exit code by connecting the real strict smoke runner to the real npm audit verifier with deterministic containment output.
2. Preserve the validated exit code in the runner result. Verify accepted nonzero results are not converted to success and existing containment failures remain fatal.
3. Update the script hash and pin-manifest digest, then run both quick pin suites before the full validation lane.
4. Review the narrow change, submit a PR, and merge only after technical CI succeeds. Do not modify any active release workflow or the frozen 0.8.31 candidate.
5. Prepare, but do not apply, a candidate-specific smoke adjudication for operator review using the existing mechanism. Record the failed metadata lane honestly and keep the independent audit required.
