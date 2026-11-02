import type { Metadata } from "next"
import { AppPage, DraftBanner } from "../AppPage"

export const metadata: Metadata = {
  title: "Agent Workspace terms",
  description: "Terms of use for Agent Workspace.",
  robots: { index: false, follow: false },
}

export default function Page() {
  return (
    <AppPage>
      <DraftBanner />
      <h1>Terms</h1>
      <p>Placeholder. The owner writes these terms of use for Agent Workspace before launch.</p>
    </AppPage>
  )
}
