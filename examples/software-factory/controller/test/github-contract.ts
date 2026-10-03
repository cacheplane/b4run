/**
 * What GitHub answered, reduced to a shape that holds no value: per request, the method, the
 * path with every id replaced, the status, and the top-level keys of the JSON body. The
 * scratch lane records it (FACTORY_TEST_GITHUB_RECORD=1) into
 * `test/fixtures/github-contract.json`; the fake server's contract test replays the same
 * delivery and requires the fake to answer every recorded request with the same status and at
 * least the same keys, so the fake cannot drift from GitHub silently (rung 4 spec §14).
 */
export interface ContractEntry {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly keys: readonly string[]
}

/** `path` with its variable parts named, so two runs record the same template. */
export function pathTemplate(path: string): string {
  return path
    .replace(/^\/repos\/[^/]+\/[^/?]+/, "/repos/{o}/{r}")
    .replace(/[0-9a-f]{40}/g, "{sha}")
    .replace(/factory\/wo-[0-9a-f]{16}/g, "factory/{id}")
    .replace(/factory%2Fwo-[0-9a-f]{16}/gi, "factory%2F{id}")
    .replace(/\/\d+(?=\/|$|\?)/g, "/{n}")
    .replace(/head=[^&]+/, "head={head}")
    .replace(/\/users\/[^/]+$/, "/users/{bot}")
}

/** A fetch that records every exchange's shape into `into`, and never a value. */
export function recordingFetch(into: ContractEntry[], inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init)
    const url = new URL(String(input instanceof Request ? input.url : input))
    let keys: string[] = []
    try {
      const body: unknown = await response.clone().json()
      keys = Array.isArray(body)
        ? ["[]"]
        : typeof body === "object" && body !== null
          ? Object.keys(body).sort()
          : []
    } catch {
      keys = []
    }
    into.push({
      method: init?.method ?? "GET",
      path: pathTemplate(`${url.pathname}${url.search}`),
      status: response.status,
      keys,
    })
    return response
  }
}
