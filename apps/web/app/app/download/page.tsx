import type { Metadata } from "next"
import { headers } from "next/headers"
import { Button } from "../../components/ui/Button"
import { flavourForHost, hostFromHeaders } from "../../lib/app-host"
import { AppPage } from "../AppPage"

export const metadata: Metadata = {
  title: "Download Agent Workspace",
  description: "Download the notarized Agent Workspace app for the Mac.",
  robots: { index: false, follow: false },
}

// `latest/download` needs a fixed asset name; the release uploads this alias
// beside the versioned zip.
const LATEST_ZIP =
  "https://github.com/cacheplane/b4app/releases/latest/download/Agent-Workspace.zip"
const RELEASES = "https://github.com/cacheplane/b4app/releases"

export default async function Page() {
  const flavour = flavourForHost(hostFromHeaders(await headers())) ?? "prod"
  const beta = flavour === "beta"
  return (
    <AppPage>
      <h1>Download Agent Workspace</h1>
      <p>
        <a href="/docs/app">Read the app guides</a>.
      </p>
      {beta ? (
        <>
          <p>
            Beta builds are published as pre-releases. Pick the newest one on the releases page.
          </p>
          <p>
            <Button href={RELEASES}>Beta releases on GitHub</Button>
          </p>
        </>
      ) : (
        <>
          <p>
            The Mac app is notarized by Apple. Unzip it and move Agent Workspace to your
            Applications folder.
          </p>
          <p>
            <Button href={LATEST_ZIP}>Download for Mac (.zip)</Button>
          </p>
          <h2>Homebrew</h2>
          <pre>
            <code>brew install --cask cacheplane/tap/agent-workspace</code>
          </pre>
        </>
      )}
      <p>
        To use it from your iPhone, see <a href="/app/help/iphone">help for iPhone</a>.
      </p>
    </AppPage>
  )
}
