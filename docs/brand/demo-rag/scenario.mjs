import { script } from "../../../packages/testing/dist/index.js"

/**
 * The deterministic compliance demo: the prompt and every scripted model turn
 * (aimock), for the parent route and its checker subagent. Only the model is
 * scripted. Every tool call runs for real over the overlay's workspace
 * (`app/server/workspace`), so the steps' citation chips are what the real
 * `searchPlans` and `readSection` return for these arguments, and the answer
 * states only what those sections say. `demo-rag.test.mjs` runs the overlay's
 * tools on the scripted arguments and checks both.
 *
 * aimock picks a fixture by the request's last user message, so the checker's
 * input never contains the prompt (and the prompt never contains the input).
 */

// The Workbench titles a thread with its first message (cut to 80
// characters), and the capture finds the thread by it.
export const RAG_PROMPT = "Are we in compliance with FEMA CPG 101?"

/** What the parent hands its checker subagent. */
export const CHECK_INPUT =
  "Review plans/sample-lakeview-county-eop.md against the basic plan elements in fema/cpg-101-plan-elements.md."

const PLAN = "plans/sample-lakeview-county-eop.md"
const ELEMENTS = "fema/cpg-101-plan-elements.md"

const TODO_CONTENT = Object.freeze([
  "Find what CPG 101 asks a basic plan to cover",
  "Find the matching sections of our plan",
  "Have the checker review each element",
  "Answer with the checklist and its sources",
])

/**
 * The parent's tool calls, in order, with the arguments the script sends. No
 * tool is called twice in a row: the activity kit folds back-to-back calls of
 * one tool into a group, which hides each call's own label and chips.
 */
export const PARENT_CALLS = Object.freeze([
  {
    tool: "writeTodos",
    args: {
      todos: TODO_CONTENT.map((content, index) => ({
        content,
        status: index === 0 ? "in_progress" : "pending",
      })),
    },
  },
  { tool: "searchPlans", args: { query: "CPG 101 basic plan elements" } },
  { tool: "readSection", args: { path: ELEMENTS, heading: "Basic plan elements" } },
  { tool: "searchPlans", args: { query: "Lakeview communications warning backup" } },
  { tool: "task", args: { subagent: "checker", input: CHECK_INPUT } },
  {
    tool: "writeTodos",
    args: { todos: TODO_CONTENT.map((content) => ({ content, status: "completed" })) },
  },
])

/** The checker's tool calls, in order. */
export const CHECKER_CALLS = Object.freeze([
  { tool: "readSection", args: { path: ELEMENTS, heading: "Communications" } },
  { tool: "searchPlans", args: { query: "communications warn public backup" } },
  { tool: "readSection", args: { path: PLAN, heading: "5. Communications" } },
  { tool: "searchPlans", args: { query: "administration finance records costs" } },
  { tool: "readSection", args: { path: PLAN, heading: "7. Plan maintenance" } },
])

/**
 * The checklist, one row per CPG 101 basic plan element, each judged from the
 * sample plan's own text (see the workspace): `where` is the plan's section.
 */
export const CHECKLIST = Object.freeze([
  {
    element: "Purpose, scope, situation and assumptions",
    status: "Met",
    where: "§1, §2",
    reason: "states its scope, hazards and the 72-hour assumption",
  },
  {
    element: "Concept of operations",
    status: "Met",
    where: "§3",
    reason: "EOC activation levels and the move to recovery",
  },
  {
    element: "Organization and assignment of responsibilities",
    status: "Met",
    where: "§4",
    reason: "a lead agency for each task",
  },
  {
    element: "Communications",
    status: "Partial",
    where: "§5",
    reason: "no accessible or multilingual warning, no backup system",
  },
  {
    element: "Administration, finance and logistics",
    status: "Missing",
    where: "none",
    reason: "no records, cost tracking or resource ordering; §6 only names a partner",
  },
  {
    element: "Plan development and maintenance",
    status: "Partial",
    where: "§7",
    reason: "updated “as needed”, with no review cycle",
  },
  {
    element: "Authorities and references",
    status: "Met",
    where: "§8",
    reason: "the state act and the county ordinance",
  },
])

/** The checker's reply: one line per element, as its prompt asks. */
export const CHECKER_REPLY = CHECKLIST.map(
  (row) => `${row.element} | ${row.status} | ${row.where} | ${row.reason}`,
).join("\n")

/** The verdict paragraph, then the table; the capture finds the answer by its first line. */
export const ANSWER_LEAD =
  "Not fully. Sample Lakeview County's plan meets four of the seven CPG 101 basic plan elements. Communications and plan maintenance are partial, and administration, finance and logistics is missing."

export const RAG_ANSWER = [
  ANSWER_LEAD,
  "",
  "| Element | Status | Where |",
  "|---|---|---|",
  ...CHECKLIST.map(
    (row) =>
      `| ${row.element} | **${row.status}** | ${row.where === "none" ? row.reason : `${row.where}: ${row.reason}`} |`,
  ),
].join("\n")

/** One aimock script for the parent and the checker, plus what the capture asserts. */
export function ragScenario() {
  const builder = script().user(RAG_PROMPT)
  for (const call of PARENT_CALLS) builder.callsTool(call.tool, call.args)
  builder.replies(RAG_ANSWER).user(CHECK_INPUT)
  for (const call of CHECKER_CALLS) builder.callsTool(call.tool, call.args)
  const fixtures = builder.replies(CHECKER_REPLY).build()
  return {
    prompt: RAG_PROMPT,
    checkInput: CHECK_INPUT,
    todos: PARENT_CALLS[0].args.todos.map((todo) => ({ ...todo })),
    answerLead: ANSWER_LEAD,
    answer: RAG_ANSWER,
    checklist: CHECKLIST.map((row) => ({ ...row })),
    parentTools: PARENT_CALLS.map((call) => call.tool),
    checkerTools: CHECKER_CALLS.map((call) => call.tool),
    fixtures,
  }
}
