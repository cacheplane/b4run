export default async function lookupBeta(input: { query: string }): Promise<string> {
  return `beta result for ${input.query}`
}
