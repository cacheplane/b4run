import type { B4Agent, DelegationConstraintPredicate } from "@b4run/sdk"

export type DescriptorRouteIndex = ReadonlyMap<B4Agent, readonly string[]>

export type ResolvedDelegationRule =
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly reason?: string }
  | { readonly action: "approve"; readonly reason?: string }
  | { readonly action: "constrain"; readonly predicate: DelegationConstraintPredicate }

export interface ResolvedSubagent {
  readonly name: string
  readonly routeId: string
  readonly source: "convention" | "explicit"
  readonly description: string
  readonly rule: ResolvedDelegationRule
}
