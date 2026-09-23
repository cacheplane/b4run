/**
 * The drafter's whole environment. It runs no build and no tests, so the framework's
 * documented base image is all it needs: `node:24-slim`, pinned by digest so the sandbox's
 * identity is fixed rather than whatever the tag points at on the day. The digest is the
 * manifest list's, as `docker pull node:24-slim` records it in `RepoDigests` (resolved
 * 2026-09-22). Task 5's CI lane pulls it by this reference; `FACTORY_DRAFTER_IMAGE` overrides
 * it for a lane that has staged a different image.
 */
export const DRAFTER_IMAGE =
  "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6"
