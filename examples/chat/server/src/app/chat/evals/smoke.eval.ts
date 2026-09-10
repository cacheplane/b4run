import { contains, defineEval } from "@b4run/evals"
import { script } from "@b4run/testing"

export default defineEval({
  name: "chat smoke",
  dataset: [
    {
      name: "greets the user",
      input: "hello",
      fixtures: script().user("hello").replies("Hi! How can I help?"),
    },
  ],
  scorers: [contains("help", { threshold: 1 })],
  threshold: 1,
})
