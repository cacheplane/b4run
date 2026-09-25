/** Greet someone by name. */
export default async (input: { readonly name: string }) => {
  return { message: `Hello, ${input.name}!` }
}
