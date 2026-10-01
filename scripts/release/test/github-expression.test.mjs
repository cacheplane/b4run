import assert from "node:assert/strict"
import test from "node:test"

import { evaluateExpression, UNKNOWN, unwrapExpression } from "./github-expression.mjs"

const context = {
  github: {
    event_name: "pull_request",
    actor: "Blove",
    event: { pull_request: { head: { ref: "factory/wo-1" }, user: { login: "b4-factory[bot]" } } },
  },
  needs: { scope: { result: "success", outputs: { prose_only: "false" } } },
  status: { always: true, success: true, failure: false, cancelled: false },
}
const evaluate = (expression) => evaluateExpression(expression, context)

test("compares strings case-insensitively, as GitHub does", () => {
  assert.equal(evaluate("github.actor == 'blove'"), true)
  assert.equal(evaluate("github.event.pull_request.user.login != 'B4-Factory[bot]'"), false)
  assert.equal(evaluate("startsWith(github.event.pull_request.head.ref, 'FACTORY/')"), true)
})

test("reads missing properties as null and answers the status functions from the context", () => {
  assert.equal(evaluate("github.event.pull_request.head.label == null"), true)
  assert.equal(evaluate("!cancelled() && needs.scope.result == 'success'"), true)
  assert.equal(evaluate("needs.scope.outputs.prose_only != 'true'"), true)
  assert.equal(evaluate("needs['scope'].outputs['prose_only'] == 'false'"), true)
})

test("binds ! tighter than ==, && tighter than ||, and honours parentheses", () => {
  assert.equal(
    evaluate("!startsWith(github.event.pull_request.head.ref, 'factory/') || true"),
    true,
  )
  assert.equal(evaluate("false && false || true"), true)
  assert.equal(evaluate("false && (false || true)"), false)
  assert.equal(evaluate(`\${{ github.event_name == 'pull_request' }}`), true)
})

test("fails closed on what it does not understand", () => {
  assert.throws(() => evaluate("fromJSON('true')"), /Unsupported function/u)
  assert.throws(() => evaluate("github.event_name =="), /end of expression/u)
  assert.throws(() => evaluate("a ~ b"), /Unexpected input/u)
  assert.throws(() => evaluate("success(1)"), /no arguments/u)
  assert.throws(() => unwrapExpression(`x == \${{ y }}`), /partly wrapped/u)
})

test("in three-valued mode, what the context leaves unstated stays unknown", () => {
  const partial = {
    unknownByDefault: true,
    github: { event_name: "pull_request", event: { pull_request: { head: { ref: "factory/x" } } } },
    status: { always: true },
  }
  const ask = (expression) => evaluateExpression(expression, partial)
  assert.equal(ask("needs.scope.outputs.deploy == 'true'"), UNKNOWN)
  assert.equal(ask("failure()"), UNKNOWN)
  assert.equal(ask("!startsWith(github.event.pull_request.head.label, 'x')"), UNKNOWN)
  assert.equal(ask("!startsWith(github.event.pull_request.head.ref, 'factory/')"), false)
  // false && unknown, unknown && false: false. unknown || true: true.
  assert.equal(ask("github.event_name == 'push' && failure()"), false)
  assert.equal(ask("failure() && github.event_name == 'push'"), false)
  assert.equal(ask("failure() || always()"), true)
  assert.equal(ask("failure() || github.event_name == 'push'"), UNKNOWN)
})
