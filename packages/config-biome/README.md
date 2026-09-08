# @b4run/config-biome

Shared Biome lint and format configuration for B4.run TypeScript workspace packages.

**Use this when:** You are extending B4.run's internal shared Biome configuration. Application authors may copy these conventions, but this package primarily follows B4.run's own workspace tooling.

## Install

Install it as a dev dependency alongside Biome:

```bash
pnpm add -D @b4run/config-biome @biomejs/biome
```

## Configuration

Extend the package from your `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.11/schema.json",
  "extends": ["@b4run/config-biome"]
}
```

Or point Biome directly at the published configuration:

```bash
pnpm exec biome check --config-path ./node_modules/@b4run/config-biome/biome.json .
```

## Runtime and stability

The root export and `@b4run/config-biome/biome` both resolve to the supported `biome.json` tooling artifact. This is static configuration with no runtime import. It is maintained for B4.run's internal workspace and may evolve with B4.run's pinned Biome version.

## Related

- [`@b4run/config-typescript`](https://www.npmjs.com/package/@b4run/config-typescript) — shared compiler configurations for the same workspace packages.
- [API catalog entry](https://b4.run/docs/api#b4runconfig-biome) — published configuration surfaces.
- [Getting Started](https://b4.run/docs/getting-started) — scaffold a B4.run application with workspace tooling configured.
- [B4.run repository contribution guide](https://github.com/cacheplane/b4run/blob/main/CONTRIBUTING.md) — workspace development commands and checks.

## Maturity and support

This package is pre-1.0 and releases in B4.run's fixed package group. Review the [changelog](https://github.com/cacheplane/b4run/blob/main/packages/config-biome/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/b4run/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/b4run/blob/main/LICENSE).
