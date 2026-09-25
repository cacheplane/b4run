/** Greet someone by name. */
export default async (input: { readonly name: string; readonly formal?: boolean }) => {
  return { message: `Hello, ${input.name}!` }
}
