import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const roots: string[] = []

/** `value` as the repository writes JSON files: two-space indent, trailing newline. */
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * A throwaway repository holding `files` (and `links`: path to symlink target; `gitlinks`: path
 * to the commit a submodule entry records) in one commit, so a pin is real without touching this
 * repository.
 */
export function pinRepo(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
  gitlinks: Readonly<Record<string, string>> = {},
): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-pin-repo-"))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  git("config", "commit.gpgsign", "false")
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    symlinkSync(target, join(root, path))
  }
  git("add", "-A")
  for (const [path, commit] of Object.entries(gitlinks))
    git("update-index", "--add", "--cacheinfo", `160000,${commit},${path}`)
  git("commit", "-q", "-m", "fixture")
  return { root, pin: git("rev-parse", "HEAD") }
}

export function cleanupPinRepos(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/**
 * A miniature pnpm monorepo shaped like this one: `@m/app` (the target: a build script that
 * does more than compile, a vitest test script) depends on `@m/core`, which depends on
 * `@m/util`; `@m/config` is a config package (no build script) every tsconfig extends;
 * `@m/tooling` is a devDependency of `@m/app` with a build of its own (installed, not
 * captured); `@m/lint` lives outside `packages/` and nothing depends on it.
 */
export const MINI: Readonly<Record<string, string>> = {
  "package.json": json({
    name: "mono",
    private: true,
    packageManager: "pnpm@10.33.0",
    devDependencies: { "@types/node": "26.1.2", typescript: "7.0.2", vitest: "4.1.11" },
  }),
  "pnpm-workspace.yaml":
    'packages:\n  - packages/*\n  - "tools/*"\n\n# built on install\nonlyBuiltDependencies:\n  - workerd\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  ".npmrc": "package-manager-strict=true\n",
  "README.md": "mono\n",
  "packages/config/package.json": json({ name: "@m/config", private: true }),
  "packages/config/base.json": json({ compilerOptions: { strict: true } }),
  "packages/util/package.json": json({
    name: "@m/util",
    scripts: { build: "tsc -b tsconfig.json", test: "vitest --run" },
    devDependencies: { "@m/config": "workspace:*" },
  }),
  "packages/util/tsconfig.json": json({
    extends: "../config/base.json",
    compilerOptions: { outDir: "dist" },
  }),
  "packages/util/tsconfig.test.json": json({ extends: "./tsconfig.json" }),
  "packages/util/src/index.ts": "export const one = 1\n",
  "packages/util/test/util.test.ts": 'import { test } from "vitest"\ntest("u", () => {})\n',
  "packages/core/package.json": json({
    name: "@m/core",
    scripts: { build: "tsc -b tsconfig.json" },
    dependencies: { "@m/util": "workspace:^" },
    devDependencies: { "@m/config": "workspace:*" },
  }),
  "packages/core/tsconfig.json": json({
    extends: "../config/base.json",
    compilerOptions: { outDir: "lib" },
  }),
  "packages/core/src/index.ts": "export const two = 2\n",
  "packages/tooling/package.json": json({
    name: "@m/tooling",
    scripts: { build: "tsc -b tsconfig.json" },
    dependencies: { "@m/util": "workspace:*" },
  }),
  "packages/tooling/tsconfig.json": json({ compilerOptions: { outDir: "dist" } }),
  "packages/tooling/src/index.ts": "export {}\n",
  "packages/app/package.json": json({
    name: "@m/app",
    scripts: {
      build: "tsc -b tsconfig.build.json && node scripts/docs.mjs",
      test: "vitest --run --config vitest.config.ts",
    },
    dependencies: { "@m/core": "workspace:*", zod: "4.4.3" },
    devDependencies: {
      "@m/config": "workspace:*",
      "@m/tooling": "workspace:*",
      "@types/node": "26.1.2",
    },
  }),
  "packages/app/tsconfig.json": json({
    extends: "../config/base.json",
    compilerOptions: { noEmit: true },
  }),
  "packages/app/tsconfig.build.json": json({
    extends: "./tsconfig.json",
    compilerOptions: { noEmit: false, outDir: "dist" },
  }),
  "packages/app/vitest.config.ts": "export default {}\n",
  "packages/app/src/index.ts": "export const three = 3\n",
  "packages/app/test/app.test.ts": 'import { test } from "vitest"\ntest("a", () => {})\n',
  "packages/app/test/helpers/h.ts": "export {}\n",
  "packages/app/scripts/docs.mjs": "\n",
  "tools/lint/package.json": json({ name: "@m/lint", private: true }),
}
