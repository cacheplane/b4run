import {
  type AuthDefinition,
  type B4Principal,
  type B4PrincipalShape,
  type B4ToolContext,
  defineAuth,
  type MiddlewareRequest,
  reject,
} from "@b4run/sdk"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type Expect<Value extends true> = Value

// With no generated `B4Register` declaration, the principal is the smallest shape.
type _Default = Expect<Equal<B4Principal, B4PrincipalShape>>

// The principal type is inferred from what `authenticate` resolves to.
const auth = defineAuth({
  authenticate: ({ headers }) =>
    headers["x-user"] ? { id: headers["x-user"], org: "acme" } : reject(401),
})
type _Inferred = Expect<Equal<typeof auth, AuthDefinition<{ id: string; org: string }>>>

// What `b4 typegen` emits reads the principal back out of the default export.
type PrincipalOf<A> = A extends AuthDefinition<infer P> ? P : never
type _RoundTrip = Expect<Equal<PrincipalOf<typeof auth>, { id: string; org: string }>>

// Every consumer receives the same type.
type _Middleware = Expect<Equal<MiddlewareRequest["principal"], B4Principal | undefined>>
type _Tool = Expect<Equal<B4ToolContext["principal"], B4Principal | undefined>>

// A principal without a string id is not a principal.
// @ts-expect-error id must be a string
defineAuth({ authenticate: () => ({ id: 1 }) })
