#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the navlog demo's web client
# (examples/navlog/web/vercel.json). Exit 0 skips the build; exit 1 builds.
#
# Adapted from apps/web/scripts/vercel-ignore-build.sh: previews build only when
# something the Workbench is built from changed, so a push elsewhere in the
# monorepo does not queue behind the team's shared build slots. Production
# always builds.
set -u

# The software factory's branches never build here: a factory/* branch holds model
# output no person has merged, and a preview build runs it with the project's
# environment. This check comes first so nothing below can be reached by one. The prefix matches in any case, as the Actions guard's startsWith
# does (spelled out, since macOS's bash 3.2 has no ${var,,}).
case "${VERCEL_GIT_COMMIT_REF:-}" in
  [Ff][Aa][Cc][Tt][Oo][Rr][Yy]/*)
    echo "Software factory branch ${VERCEL_GIT_COMMIT_REF}: never built on Vercel."
    exit 0
    ;;
esac

if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "Production deployment: building."
  exit 1
fi

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Not a git checkout: building."; exit 1; }
cd "$root" || exit 1

# Everything the Workbench's build reads: the app itself, the workspace packages
# it builds (@b4run/ag-ui, @b4run/sdk and their shared tsconfig), and the root
# workspace/tooling config.
paths=(
  examples/navlog/web
  packages/ag-ui
  packages/sdk
  packages/config-typescript
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
  echo "No navlog web inputs changed since ${base:0:12}: skipping the preview build."
  exit 0
fi

echo "Navlog web inputs changed since ${base:0:12}: building."
exit 1
