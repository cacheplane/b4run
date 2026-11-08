/** Dependency-free canonical runtime identity. Internal storage/runtime plumbing. */
export {
  isProtectedSource,
  isStoppedSourceProof,
  protectedSourceDigest,
  protectedSourceId,
  runtimeStoppedSourceWitness,
  stoppedSourceMatchesRun,
} from "../pure/protected-source.js"
export { canonicalRuntimeValue, runtimePermissionProposalHash } from "../pure/runtime-identity.js"
