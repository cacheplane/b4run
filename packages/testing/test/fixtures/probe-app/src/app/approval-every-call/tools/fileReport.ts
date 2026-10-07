export default async function fileReport(input: { title: string }): Promise<string> {
  return `filed ${input.title}`
}
