import { RunnableSequence } from "@langchain/core/runnables"

export const chain = RunnableSequence.from([
  (input: { readonly name: string }) => input.name.trim(),
  (name: string) => ({ message: `Hello, ${name}!` }),
])
