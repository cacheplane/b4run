import type { Metadata } from "next"
import { AppPage, DraftBanner } from "../AppPage"

export const metadata: Metadata = {
  title: "Agent Workspace privacy",
  description: "How Agent Workspace handles your data.",
  robots: { index: false, follow: false },
}

export default function Page() {
  return (
    <AppPage>
      <DraftBanner />
      <h1>Privacy</h1>
      <p>
        Placeholder. The owner writes the privacy policy for Agent Workspace before launch. This is
        separate from the privacy policy for the B4.run framework and website.
      </p>
    </AppPage>
  )
}
