/** Storage encoding AFTER the existing public wire normalization. No key sorting or numeric extension. */
export type RecoveryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RecoveryJsonValue[]
  | { readonly [key: string]: RecoveryJsonValue }
export type RecoveryEntityKind =
  | "thread"
  | "run"
  | "turn"
  | "pending"
  | "activity"
  | "message"
  | "namespace"
  | "maintenance"
  | "checkpoint"
export type RecoveryIdentityTuple =
  | readonly [1, string, string]
  | readonly [
      1,
      string,
      string,
      readonly string[],
      RecoveryEntityKind,
      string | null | readonly [string, string, string, string],
    ]
function supported(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("Unsupported recovery JSON")
  const array = Array.isArray(value)
  if (array && Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error("Unsupported recovery JSON")
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Unsupported recovery JSON")
  ancestors.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    if (
      Object.getOwnPropertySymbols(value).length ||
      (array &&
        (keys.length !== value.length + 1 ||
          !keys.includes("length") ||
          Array.from({ length: value.length }, (_, index) => String(index)).some(
            (key) => !keys.includes(key),
          )))
    )
      throw new Error("Unsupported recovery JSON")
    for (const key of keys) {
      if (array && key === "length") continue
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new Error("Unsupported recovery JSON")
      supported(descriptor.value, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}
export function asciiJsonV1(value: RecoveryJsonValue): string {
  supported(value, new Set())
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}
export function parseAsciiJsonV1(source: string): RecoveryJsonValue {
  if (!/^[\x20-\x7e]*$/.test(source)) throw new Error("Noncanonical recovery JSON")
  const value: RecoveryJsonValue = JSON.parse(source)
  if (asciiJsonV1(value) !== source) throw new Error("Noncanonical recovery JSON")
  return value
}
function identity(value: RecoveryJsonValue): value is RecoveryIdentityTuple {
  if (
    !Array.isArray(value) ||
    value[0] !== 1 ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "string"
  )
    return false
  if (value.length === 3) return true
  if (
    value.length !== 6 ||
    !Array.isArray(value[3]) ||
    value[3].some((part: unknown) => typeof part !== "string")
  )
    return false
  const kind = value[4],
    id = value[5]
  if (typeof kind !== "string") return false
  if (kind === "namespace") return id === null
  if (kind === "pending")
    return (
      Array.isArray(id) && id.length === 4 && id.every((part: unknown) => typeof part === "string")
    )
  return (
    ["thread", "run", "turn", "activity", "message", "maintenance", "checkpoint"].includes(kind) &&
    typeof id === "string"
  )
}
export function encodeRecoveryIdentityTuple(value: RecoveryIdentityTuple): string {
  const source = asciiJsonV1(value)
  if (!identity(value)) throw new Error("Invalid recovery identity tuple")
  return source
}
export function decodeRecoveryIdentityTuple(source: string): RecoveryIdentityTuple {
  const value = parseAsciiJsonV1(source)
  if (!identity(value)) throw new Error("Invalid recovery identity tuple")
  return value
}
