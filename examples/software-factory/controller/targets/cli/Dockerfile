ARG BASE_IMAGE=node:24-slim
ARG PLATFORM=linux/arm64
FROM --platform=${PLATFORM} ${BASE_IMAGE}
ARG PNPM_VERSION
# git for the workspace baseline; pnpm via npm, not corepack, because corepack caches the
# binary in the enabling user's home and the container runs as `node` with no network.
# git is resolved by apt at build time and is not part of the recorded image inputs; an
# accepted gap, recorded in the rung 2 spec's risks.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}
WORKDIR /opt/targets/cli
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
# Manifests only: every workspace package is relinked below to the WORKSPACE copy, where the
# build writes its dist/, so the image's copies need nothing but what pnpm reads to install.
COPY packages packages
# Hoisted, so one root node_modules holds everything and the workspace needs one link.
RUN pnpm install --frozen-lockfile --filter @b4run/cli... --ignore-scripts --config.node-linker=hoisted \
 && chmod -R a+rX /opt/targets/cli
# The workspace can hold exactly ONE environment link (`node_modules`, at its root): the
# inspection that snapshots it refuses a symlink anywhere else. So everything a captured
# package resolves must be in the ROOT node_modules, and three things the hoisted install
# left elsewhere are moved there:
#  1. Nested dependencies. Hoisting keeps the root project's version at the root and nests a
#     package's conflicting one under packages/<p>/node_modules. At the default pin that is
#     cli's @hono/node-server, ag-ui's axe-core, and the TypeScript 6 compiler API
#     (`typescript`, aliased to @typescript/typescript6) that core's typegen imports and ag-ui
#     nests too. Each is promoted over the root's. EXPECTED_PROMOTED is that set, by the name
#     the loop sees, and it is PIN-SPECIFIC: a lockfile change that nests a different set at
#     another pin fails the build ("promoted over the root's: …" names the actual set) rather
#     than silently replacing a root package the other packages resolve; update it with the
#     pin. One name nested by two packages is promoted once when both copies are the same name
#     and version (their package.json agree); two versions fail.
#  2. The root's own TypeScript 7 (the `tsc` every package builds with) would be overwritten
#     by that promotion, so it moves aside first and `tsc` becomes a shim onto it.
#  3. Workspace links. pnpm writes them relative (`../../packages/core`), which resolves to
#     the image's manifest-only copy; they are rewritten to the workspace's own package.
# CAPTURED is the packages the workspace holds (the target's capture), the only ones relinked.
RUN set -eu \
 && CAPTURED="ag-ui cli config-typescript core langchain langgraph memory permissions sdk sqlite-storage workspace" \
 && mkdir -p tools/node_modules && mv node_modules/typescript tools/node_modules/typescript \
 && rm -f node_modules/.bin/tsc \
 && printf '#!/bin/sh\nexec node /opt/targets/cli/tools/node_modules/typescript/bin/tsc "$@"\n' > node_modules/.bin/tsc \
 && chmod 755 node_modules/.bin/tsc \
 && EXPECTED_PROMOTED="@hono/node-server axe-core typescript" \
 && PROMOTED="" \
 && for p in $CAPTURED; do \
      nm="packages/$p/node_modules"; [ -d "$nm" ] || continue; \
      for entry in "$nm"/* "$nm"/@*/*; do \
        [ -e "$entry" ] || continue; \
        rel="${entry#"$nm"/}"; \
        case "$rel" in @b4run|@b4run/*|.bin) continue ;; esac; \
        case "$rel" in @*/*) ;; @*) continue ;; esac; \
        case " $PROMOTED " in *" $rel "*) \
          if node -e 'const f=require("node:fs");const r=p=>{const j=JSON.parse(f.readFileSync(p+"/package.json","utf8"));return j.name+"@"+j.version};process.exit(r(process.argv[1])===r(process.argv[2])?0:1)' "node_modules/$rel" "$entry"; then \
            echo "promoted once: $rel (packages/$p nests the same version)"; rm -rf "$entry"; continue; \
          fi; echo "promoted twice: $rel (again from packages/$p, another version)" >&2; exit 1 ;; esac; \
        PROMOTED="$PROMOTED $rel"; \
        rm -rf "node_modules/$rel" && mkdir -p "node_modules/$(dirname "$rel")" && mv "$entry" "node_modules/$rel"; \
      done; \
      rm -rf "$nm"; \
    done \
 && actual="$(printf '%s\n' $PROMOTED | LC_ALL=C sort | tr '\n' ' ')" \
 && expected="$(printf '%s\n' $EXPECTED_PROMOTED | LC_ALL=C sort | tr '\n' ' ')" \
 && echo "promoted over the root's: $actual" \
 && if [ "$actual" != "$expected" ]; then echo "expected to promote exactly: $expected" >&2; exit 1; fi \
 && for p in $CAPTURED; do \
      rm -rf "node_modules/@b4run/$p" && ln -s "/workspace/packages/$p" "node_modules/@b4run/$p"; \
    done
# vite bundles a TypeScript config to a temp file under the NEAREST node_modules, which here
# is the image's read-only one, and it only tolerates EACCES there. Point that one scratch
# directory at /tmp, which the sandbox mounts as a writable tmpfs.
RUN ln -s /tmp /opt/targets/cli/node_modules/.vite-temp
USER node
WORKDIR /workspace
