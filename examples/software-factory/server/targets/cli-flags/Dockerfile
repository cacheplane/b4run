ARG BASE_IMAGE=node:24-slim
ARG PLATFORM=linux/arm64
FROM --platform=${PLATFORM} ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY examples/software-factory/server/fixtures/cli-flags/project/package*.json /opt/targets/cli-flags/
RUN npm ci --prefix /opt/targets/cli-flags --ignore-scripts --no-audit --no-fund
USER node
WORKDIR /workspace
