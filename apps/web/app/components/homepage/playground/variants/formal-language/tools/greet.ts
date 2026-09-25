/** Greet someone by name. */
export default async (input: {
  readonly name: string
  readonly formal?: boolean
  readonly language: "en" | "es"
}) => {
  return { message: `Hello, ${input.name}!` }
}
