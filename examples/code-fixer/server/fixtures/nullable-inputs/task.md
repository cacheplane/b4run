# Preserve nullable tool parameters

TypeScript accepts `string | null`, but the generated runtime tool validator
rejects null. Reproduce with `npm test`, trace the compiler/schema/validator
pipeline, and fix it. Preserve required versus optional properties and existing
non-nullable validation. Modify only `src/compiler/json-schema.ts` and
`src/validator.ts`; do not change tests, configuration, or the TypeScript analyzer.

A prepared diagnostic prints the generated schema and validation results without
editing project files. Replace the JSON values to inspect other tool inputs:

```sh
printf '%s' '{"source":"export default async function tool(input: { value: string | null }) { return input }","inputs":[{"value":null},{"value":"hello"}]}' | node --import tsx test/evaluate-tool.ts
```

Use this command and `npm test` for execution; inspect files with workspace tools.
