ARG BASE_IMAGE=node:24-slim
ARG PLATFORM=linux/arm64
FROM --platform=${PLATFORM} ${BASE_IMAGE}
ARG PNPM_VERSION
# git for the workspace baseline; pnpm via npm, not corepack, because corepack caches the
# binary in the enabling user's home and the container runs as `node` with no network.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}
WORKDIR /opt/targets/devkit
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/devkit/package.json packages/devkit/package.json
# Workspace siblings are copied in full: pnpm links a workspace dependency to the sibling
# directory, and a stub copy would resolve to an empty package.
COPY packages/config-typescript packages/config-typescript
# Hoisted, so one root node_modules holds everything and the workspace needs one link.
RUN pnpm install --frozen-lockfile --filter @b4run/devkit... --ignore-scripts --config.node-linker=hoisted \
 && chmod -R a+rX /opt/targets/devkit
# vite bundles a TypeScript config to a temp file under the NEAREST node_modules, which here
# is the image's read-only one, and it only tolerates EACCES there. Point that one scratch
# directory at /tmp, which the sandbox mounts as a writable tmpfs.
RUN ln -s /tmp /opt/targets/devkit/node_modules/.vite-temp
USER node
WORKDIR /workspace
