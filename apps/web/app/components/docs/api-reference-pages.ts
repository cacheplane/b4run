export interface ApiReferencePage<
  SurfaceName extends string = string,
  Href extends string = string,
> {
  readonly label: SurfaceName
  readonly href: Href
  readonly surfaceName: SurfaceName
  readonly ownerPackageNames: readonly string[]
  readonly parent: {
    readonly label: "API Reference"
    readonly href: "/docs/api"
  }
}

export const API_REFERENCE_PARENT = { label: "API Reference", href: "/docs/api" } as const

export const API_REFERENCE_PAGES = [
  referencePage("@b4run/sdk", "/docs/api/sdk", ["@b4run/sdk"]),
  referencePage("@b4run/cli", "/docs/api/cli", ["@b4run/cli"]),
  referencePage("@b4run/core", "/docs/api/core", ["@b4run/core"]),
  referencePage("@b4run/ag-ui", "/docs/api/ag-ui", ["@b4run/ag-ui"]),
  referencePage("@b4run/memory", "/docs/api/memory", ["@b4run/memory"]),
  referencePage("@b4run/memory-pgvector", "/docs/api/memory-pgvector", ["@b4run/memory-pgvector"]),
  referencePage("@b4run/postgres-storage", "/docs/api/postgres-storage", [
    "@b4run/postgres-storage",
  ]),
  referencePage("@b4run/testing", "/docs/api/testing", ["@b4run/testing"]),
  referencePage("@b4run/evals", "/docs/api/evals", ["@b4run/evals"]),
  referencePage("b4:routes", "/docs/api/generated-routes", ["@b4run/cli", "@b4run/core"]),
  referencePage("@b4run/permissions", "/docs/api/permissions", ["@b4run/permissions"]),
  referencePage("@b4run/workspace", "/docs/api/workspace", ["@b4run/workspace"]),
  referencePage("@b4run/sandbox", "/docs/api/sandbox", ["@b4run/sandbox"]),
  referencePage("@b4run/langgraph", "/docs/api/langgraph", ["@b4run/langgraph"]),
  referencePage("@b4run/langchain", "/docs/api/langchain", ["@b4run/langchain"]),
  referencePage("@b4run/sqlite-storage", "/docs/api/sqlite-storage", ["@b4run/sqlite-storage"]),
] as const satisfies readonly ApiReferencePage[]

function referencePage<const SurfaceName extends string, const Href extends string>(
  surfaceName: SurfaceName,
  href: Href,
  ownerPackageNames: readonly string[],
): ApiReferencePage<SurfaceName, Href> {
  return {
    label: surfaceName,
    href,
    surfaceName,
    ownerPackageNames,
    parent: API_REFERENCE_PARENT,
  }
}
