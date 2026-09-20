ARG BASE_IMAGE=node:24-slim
ARG PLATFORM=linux/arm64
FROM --platform=${PLATFORM} ${BASE_IMAGE}
# Unused here, but accepted by every target so the prepare script's build args are uniform.
ARG PNPM_VERSION
# git is resolved by apt at build time and is not part of the recorded image inputs; an
# accepted gap, recorded in the rung 2 spec's risks.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY examples/software-factory/server/fixtures/cli-flags/project/package*.json /opt/targets/cli-flags/
RUN npm ci --prefix /opt/targets/cli-flags --ignore-scripts --no-audit --no-fund \
 && chmod -R a+rX /opt/targets/cli-flags
USER node
WORKDIR /workspace
