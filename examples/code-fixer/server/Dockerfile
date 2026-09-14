ARG BASE_IMAGE=node:24-slim
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY fixtures/cli-flags/project/package*.json /opt/fixtures/cli-flags/
COPY fixtures/nullable-inputs/project/package*.json /opt/fixtures/nullable-inputs/
RUN npm ci --prefix /opt/fixtures/cli-flags --ignore-scripts --no-audit --no-fund && npm ci --prefix /opt/fixtures/nullable-inputs --ignore-scripts --no-audit --no-fund
USER node
WORKDIR /workspace
