import { expect, it } from "vitest"
import { formatSchema } from "./format-schema"

it("keeps scalar arrays and small scalar objects on one line", () => {
  expect(
    formatSchema({
      name: "greet",
      description: "Greet someone by name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          formal: { type: "boolean" },
          language: { type: "string", enum: ["en", "es"] },
        },
        required: ["name", "language"],
        additionalProperties: false,
      },
    }),
  ).toEqual([
    "{",
    '  "name": "greet",',
    '  "description": "Greet someone by name.",',
    '  "parameters": {',
    '    "type": "object",',
    '    "properties": {',
    '      "name": { "type": "string" },',
    '      "formal": { "type": "boolean" },',
    '      "language": { "type": "string", "enum": ["en", "es"] }',
    "    },",
    '    "required": ["name", "language"],',
    '    "additionalProperties": false',
    "  }",
    "}",
  ])
})

it("breaks a scalar object that does not fit the width", () => {
  expect(formatSchema({ a: "x".repeat(40), b: "y".repeat(40) }, 64)).toEqual([
    "{",
    `  "a": "${"x".repeat(40)}",`,
    `  "b": "${"y".repeat(40)}"`,
    "}",
  ])
})

it("prints what it is given and nothing else", () => {
  expect(formatSchema([])).toEqual(["[]"])
  expect(formatSchema({})).toEqual(["{}"])
  expect(() => formatSchema({ run: () => 1 })).toThrow("Not a JSON value: function")
})
