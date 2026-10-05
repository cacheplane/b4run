"use client"
import { useConfigureSuggestions } from "@copilotkit/react-core/v2"

// Starter prompts for the empty chat. The planner's most interesting behavior
// is model-driven — it only dispatches subagents, computes a navlog, asks for
// approval, or proposes a memory if the request steers it there — so without a
// nudge a new user is unlikely to discover any of it.
//
// `useConfigureSuggestions` takes a static list ({ title, message }); `available`
// defaults to "before-first-message", so these appear on the empty chat and go
// away once the conversation starts.
//
// - "Plan a flight" drives recall → plan → the performance subagent → computeNavlog → a saved report
// - "File the plan" drives fileFlightPlan, which the route approves per call, so the approve/deny flow is on screen
// - "Teach it the aircraft" drives remember() → a memory candidate in the rail's memory panel
//   (`MemoryPanel.tsx`) for approval. Nothing the agent proposes becomes a real
//   memory until that click, so the whole loop is on screen.
export function DemoSuggestions() {
  useConfigureSuggestions(
    {
      suggestions: [
        {
          title: "Plan a flight",
          message:
            "Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z, and save the navlog.",
        },
        {
          title: "File the plan",
          message: "File the flight plan for KSTP to KRST.",
        },
        {
          title: "Teach it the aircraft",
          message:
            "My airplane is N738ZU, a Cessna 172N. I cruise at 2400 RPM with 50 gallons usable.",
        },
      ],
    },
    [],
  )
  return null
}
