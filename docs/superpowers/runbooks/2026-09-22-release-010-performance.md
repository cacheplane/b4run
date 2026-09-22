# Release 0.10.0 performance — September 22, 2026

## Outcome and phase timings

Candidate bfaf0c2b3030eebb572703c8f70f0e063593b1fa merged in
[PR #782](https://github.com/cacheplane/b4run/pull/782) at 05:51:11Z.
[Release 0.10.0](https://github.com/cacheplane/b4run/releases/tag/v0.10.0)
became public at 07:33:43Z: **1h42m32s**, versus 0.9.0's 1h32m25s
(an increase of 10m07s). Both had one successful publishing attempt.
The candidate contains discovery inventory reuse PR #766.

| Phase | 0.10.0 | 0.9.0 |
| --- | --- | --- |
| Candidate main CI, run creation through completion | 17m28s | 17m21s |
| Main observation (includes CI wait) | 17m42s | 17m15s |
| Tag observation | 9m17s | 8m55s |
| Preparation step | 3m23s | 3m47s |
| Escrow step | 2m07s | 2m26s |
| Serial publish and verify step | 58m53s | 49m35s |
| Recorded registry wait lower bound | 52m23.465s | 43m38.337s |

Preparation, escrow, observation and publishing rows compare the same named
steps in both runs. Critical evidence:
[main CI 35692336680](https://github.com/cacheplane/b4run/actions/runs/35692336680),
[main release 35692336619](https://github.com/cacheplane/b4run/actions/runs/35692336619),
[tag release 35693673498](https://github.com/cacheplane/b4run/actions/runs/35693673498).
There is no measured overall discovery improvement yet: tag observation grew 22s.
The publisher step was only 67s shorter than its 60-minute overall budget.

## Convergence breakdown

The log records 21 accepted packages and 485 registry-pending events: 395 version-absent,
6 metadata-pending and 84 audit-pending. All 84 audit diagnostics are ETARGET.
The wait lower bound sums each package's largest logged elapsedMs; it includes
work between observations and excludes unlogged tails. It is not pure sleep time.

Three packages have 28 consecutive audit-pending events each:

| Package | First to last audit-pending span |
| --- | --- |
| @b4run/config-typescript | 291.206s |
| @b4run/sqlite-storage | 292.296s |
| @b4run/memory-pgvector | 292.269s |

The combined logged span is 875.771s (14m35.771s), plus unlogged successful tails.
Historical cache responses were not saved; this strongly matches a five-minute
metadata cache but does not prove how much of those intervals was avoidable.
Version-absent delays remain a separate, larger investigation. Current read-only
public-registry probes show packument Cache-Control public,max-age=300; a no-cache
request still returned a CDN HIT. Do not assume a header fixes CDN propagation.

## Reproduced local npm cache behavior

The release uses npm 11.17.0. Its signature verifier calls pacote.manifest with
verifySignatures and verifyAttestations enabled. Registry metadata fetched before
the desired version becomes visible can stay in the private npm cache. Pacote's
registry implementation explicitly has a TODO for ETARGET cache revalidation.
The verifier reuses this cache across retry processes.

The controlled localhost experiment below uses npm 11.17.0's actual pacote and a
registry response with max-age 300. It introduces no project dependency and publishes
nothing. It proves the read/cache mechanism, not a complete signature verification:
the fixture deliberately has no signatures or attestations.

Output:

```json
{"mode":"initial-absent","code":"ETARGET","requests":1}
{"mode":"default-after-visible","code":"ETARGET","requests":1}
{"mode":"prefer-online-after-visible","version":"1.0.1","requests":2}
```

npm documents prefer-online as forcing cached-data staleness checks:
[configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#prefer-online).
Enable npm_config_prefer_online=true only for the isolated audit subprocess
environment. Preserve the cache, cryptographic checks, retries, deadlines,
publishing order, registry adapter, and all workflow steps. Publishing itself
receives no new configuration. This eliminates a reproduced avoidable wait without
another operational step. Real release savings await the next ordinary release.

## Validation

The added environment assertions failed before the production change and pass
after it. The complete npm-audit/publisher files pass 200 tests; release integrity
passes 33 and workflow contracts pass 166. Scoped Biome, whitespace, workspace
build and docs checks pass. The full controller suite and hosted merge gates are
recorded in the pull request. The cache probe above provides separate actual-npm
behavior evidence; injected subprocess tests verify configuration and evidence handling.

## Reproduction

Create a disposable directory, run npm pack npm@11.17.0 there and extract its tarball.
Set the require path below to that extracted package/node_modules/pacote.
Run with Node 24.20.0. The probe uses only a local HTTP fixture and a temporary cache,
which it removes on completion.

```javascript
const http = require("node:http")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const pacote = require("/tmp/b4-npm-1117-probe/package/node_modules/pacote")
;(async () => {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "b4-cache-probe-"))
  let visible = false,
    requests = 0
  const server = http.createServer((req, res) => {
    requests++
    const versions = {}
    for (const version of visible ? ["1.0.0", "1.0.1"] : ["1.0.0"])
      versions[version] = {
        name: "b4-cache-probe",
        version,
        dist: {
          tarball: "https://registry.npmjs.org/b4-cache-probe/-/b4-cache-probe-" + version + ".tgz",
          shasum: "a".repeat(40),
        },
      }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    })
    res.end(
      JSON.stringify({
        name: "b4-cache-probe",
        "dist-tags": { latest: visible ? "1.0.1" : "1.0.0" },
        versions,
      }),
    )
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const registry = `http://127.0.0.1:${server.address().port}`
  try {
    for (const mode of ["initial-absent", "default-after-visible", "prefer-online-after-visible"]) {
      if (mode !== "initial-absent") visible = true
      try {
        const result = await pacote.manifest("b4-cache-probe@1.0.1", {
          registry,
          cache,
          verifySignatures: true,
          verifyAttestations: true,
          preferOnline: mode.startsWith("prefer-online"),
        })
        console.log(JSON.stringify({ mode, version: result.version, requests }))
      } catch (e) {
        console.log(JSON.stringify({ mode, code: e.code, requests }))
      }
    }
  } finally {
    server.close()
    await fs.rm(cache, { recursive: true, force: true })
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
```
