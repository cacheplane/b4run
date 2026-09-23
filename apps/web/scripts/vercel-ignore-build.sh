#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the b4.run website (apps/web/vercel.json).
# Exit 0 skips the build; exit 1 builds.
#
# Every push to any branch used to build a full website preview, which queued
# behind the team's shared build slots and delayed unrelated work (the
# vercel-native CI lane timed out waiting in that queue). Previews now build
# only when something the site is built from changed. Production always builds.
set -u

if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "Production deployment: building."
  exit 1
fi

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Not a git checkout: building."; exit 1; }
cd "$root" || exit 1

# Everything the site's build reads: the app itself, the workspace packages it
# builds and documents, and the root workspace/tooling config.
paths=(
  apps/web
  packages
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  turbo.json
  tsconfig.json
  .npmrc
)

# Prefer the commit this branch last deployed; fall back to the parent commit
# (Vercel's clone is shallow, so the previous SHA may be missing).
base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="$(git rev-parse --verify --quiet HEAD^)" || { echo "No base commit to compare: building."; exit 1; }
fi

if git diff --quiet "$base" HEAD -- "${paths[@]}"; then
  echo "No website inputs changed since ${base:0:12}: skipping the preview build."
  exit 0
fi

echo "Website inputs changed since ${base:0:12}: building."
exit 1
