export interface OpenApiDocument {
  openapi: string
  info: { version: string }
  paths: Record<string, Record<string, unknown>>
  components: { schemas: Record<string, unknown> }
}
export interface AgentProtocolManifest {
  repository: string
  commit: string
  versions: { openapi: string; cddl: string }
  license: string
  files: { path: string; url: string; sha256: string; gitBlobSha1: string; bytes: number }[]
}
export interface AgentProtocolCorrections {
  sourceSha256: string
  operations: [{ op: string; path: string; expected: string[] }]
  reason: string
}
export function applyAgentProtocolCorrection(document: OpenApiDocument): OpenApiDocument
export function readAgentProtocolInputs(options?: { fixturesDirectory?: string }): {
  originalOpenapi: OpenApiDocument
  correctedOpenapi: OpenApiDocument
  manifest: AgentProtocolManifest
  corrections: AgentProtocolCorrections
  sourceTexts: { cddl: string; license: string }
}
