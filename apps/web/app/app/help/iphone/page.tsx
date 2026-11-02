import type { Metadata } from "next"
import { AppPage } from "../../AppPage"

export const metadata: Metadata = {
  title: "Agent Workspace on iPhone",
  description: "Pair your iPhone with Agent Workspace on your Mac.",
  robots: { index: false, follow: false },
}

export default function Page() {
  return (
    <AppPage>
      <h1>Agent Workspace on iPhone</h1>
      <h2>Pair your iPhone</h2>
      <ol>
        <li>On your Mac, open Agent Workspace and choose "Add your iPhone".</li>
        <li>
          On your iPhone, open Agent Workspace and scan the code. You can also point the iPhone's
          Camera at the code and tap the link it shows.
        </li>
        <li>
          Confirm the pairing on your iPhone. The code works once and expires after 5 minutes; ask
          your Mac for a new one if it has expired.
        </li>
      </ol>
      <h2>Get the Mac app</h2>
      <p>
        The iPhone app works with Agent Workspace on a Mac. <a href="/app/download">Download it</a>{" "}
        first.
      </p>
    </AppPage>
  )
}
