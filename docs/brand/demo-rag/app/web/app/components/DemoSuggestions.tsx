"use client"
import { useConfigureSuggestions } from "@copilotkit/react-core/v2"

// Starter prompts for the empty chat; they go away once the conversation starts.
export function DemoSuggestions() {
  useConfigureSuggestions(
    {
      suggestions: [
        { title: "Check compliance", message: "Are we in compliance with FEMA CPG 101?" },
        {
          title: "Communications",
          message: "How does our plan warn residents who are deaf or read other languages?",
        },
      ],
    },
    [],
  )
  return null
}
