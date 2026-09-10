/**
 * `@b4run/sdk/pure` — dependency-free path and hash helpers.
 *
 * They live here, in a package with no `node:` imports and no `@b4run/*`
 * dependencies, because every B4.run package on the request path needs them: the
 * edge targets forbid `node:` imports, and `@b4run/sdk` is the one package
 * `core`, `langchain`, `permissions` and `workspace` can all depend on without
 * creating a cycle.
 */

export { sha1Hex, sha256Hex } from "./hash.js"
export {
  POSIX_SEP,
  pureBasename,
  pureDirname,
  pureJoin,
  pureRelative,
  pureResolve,
} from "./path.js"
