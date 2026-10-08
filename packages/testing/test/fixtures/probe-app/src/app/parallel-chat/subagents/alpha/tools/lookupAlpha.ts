export default async function lookupAlpha(input: { query: string }): Promise<string> {
  return `alpha result for ${input.query}`
}
