import type { ConfigFileId } from "./gate-scenarios"
import sources from "./gate-sources.json"

/** The two fixture files the tracer shows; gate-scenarios.test.ts pins each to disk. */
export const gateSources: Readonly<Record<ConfigFileId, string>> = sources
