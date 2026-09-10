# @b4run/sandbox

Docker and Kubernetes sandbox providers for isolated B4.run workspace execution.

**Use this when:** You need to isolate workspace filesystem and shell execution from the B4.run host process.

## Install

```bash
pnpm add @b4run/sandbox
```

## Example

```ts
import { dockerSandbox } from "@b4run/sandbox"
import { fakeSandbox } from "@b4run/sandbox/testing"

const provider = dockerSandbox({ image: "node:24-slim" })
const testProvider = fakeSandbox()
```

## Runtime and stability

- `@b4run/sandbox` is a node-only, supported application surface.
- `@b4run/sandbox/testing` is a node-only, supported testing surface.

A sandbox narrows where workspace operations run; applications still own image hardening, credentials, network policy, and resource limits.

## Related

- [Sandbox API reference](https://b4.run/docs/api/sandbox) — Docker, Kubernetes, and testing provider contracts.
- [Execution Sandbox guide](https://b4.run/docs/sandbox) — application setup and security boundaries.
- [`@b4run/workspace`](https://www.npmjs.com/package/@b4run/workspace) — the filesystem and shell contracts sandbox providers implement.

## Maturity and support

B4.run is pre-1.0, and its public surface can change. All publishable B4.run packages release together as a fixed group; review the [`@b4run/sandbox` changelog](https://github.com/cacheplane/b4run/blob/main/packages/sandbox/CHANGELOG.md) and [upgrading guide](https://b4.run/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/b4run/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
