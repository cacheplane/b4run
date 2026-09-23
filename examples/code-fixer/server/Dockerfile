# Pinned by digest: preparation reuses a locally held base, and the image tag is
# derived from this file, so the base can never change underneath a tag.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY sample/project/package*.json /opt/fixtures/cli-flags/
RUN npm ci --prefix /opt/fixtures/cli-flags --ignore-scripts --no-audit --no-fund
USER node
WORKDIR /workspace
