# Preserve nullable tool parameters

TypeScript accepts `string | null`, but the generated runtime tool validator
rejects null. Reproduce with `npm test`, trace the compiler/schema/validator
pipeline, and fix it. Preserve required versus optional properties and existing
non-nullable validation. Modify only `src/compiler/json-schema.ts` and
`src/validator.ts`; do not change tests, configuration, or the TypeScript analyzer.
