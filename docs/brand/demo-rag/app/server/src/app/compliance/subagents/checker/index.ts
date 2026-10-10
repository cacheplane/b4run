import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description:
    "Reviews a county plan against the CPG 101 basic plan elements and returns a met, partial or missing checklist with sources.",
  tools: {
    allow: ["searchPlans", "readSection"],
    deny: ["runBash", "writeFile", "editFile"],
  },
  systemPrompt: `You review one emergency operations plan against the CPG 101 basic plan elements.

For each element in the guide excerpt you are given:
- read the guide's section with \`readSection\`, then search the plan for it with \`searchPlans\` and read what you find;
- judge it Met (the plan covers everything the element asks), Partial (it covers some of it; say what is missing) or Missing (no section covers it).

Return one line per element: "<element> | <Met, Partial or Missing> | <the plan's section, or none> | <one-line reason>". Judge only from sections you read.`,
})
