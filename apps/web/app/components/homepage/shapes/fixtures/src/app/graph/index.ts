import { Annotation, END, START, StateGraph } from "@langchain/langgraph"

const Hello = Annotation.Root({
  name: Annotation<string>,
  message: Annotation<string>,
})

export const graph = new StateGraph(Hello)
  .addNode("greet", (state) => ({ message: `Hello, ${state.name}!` }))
  .addEdge(START, "greet")
  .addEdge("greet", END)
  .compile()
