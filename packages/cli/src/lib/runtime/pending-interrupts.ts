import type {
  AspInputRespondEntry,
  AspInputRespondParams,
  PermissionResponseV1,
  RuntimePendingRecord,
} from "@b4run/sdk/agent-protocol"
import { ProtocolError } from "../dev/protocol/errors.js"
import { protocolRecord } from "../dev/protocol/metadata.js"
import { canonical } from "./operation-ledger.js"

export function permissionResponseEntries(
  params: AspInputRespondParams,
): readonly AspInputRespondEntry[] {
  return "responses" in params ? params.responses : [params]
}
export function permissionResponse(value: unknown): PermissionResponseV1 {
  const row = protocolRecord(value)
  if (
    Object.keys(row).some((key) => key !== "decision" && key !== "grant") ||
    typeof row.decision !== "string" ||
    !["once", "always", "deny"].includes(row.decision) ||
    (Object.hasOwn(row, "grant") && typeof row.grant !== "string")
  )
    throw new ProtocolError("invalid_argument")
  return row as unknown as PermissionResponseV1
}
export function permissionAddress(entry: {
  readonly namespace: readonly string[]
  readonly interruptId: string
}): string {
  return canonical([entry.namespace, entry.interruptId])
}
/** Complete across every nested namespace. This is validation only: no grant or
 * pending disposition can change before the entire current set is checked. */
export function completePermissionResponses(
  pending: readonly RuntimePendingRecord[],
  params: AspInputRespondParams,
): ReadonlyMap<string, AspInputRespondEntry> {
  const answers = permissionResponseEntries(params),
    byAddress = new Map(answers.map((entry) => [permissionAddress(entry), entry]))
  if (
    !pending.length ||
    answers.length !== pending.length ||
    byAddress.size !== answers.length ||
    pending.some(
      (entry) =>
        !byAddress.has(
          permissionAddress({
            namespace: entry.namespace,
            interruptId: entry.input.data.interruptId,
          }),
        ),
    )
  )
    throw new ProtocolError("incomplete_responses")
  return byAddress
}
