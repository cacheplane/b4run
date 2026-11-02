import type { Metadata } from "next"
import { headers } from "next/headers"
import { AppPage } from "../app/AppPage"
import { Button } from "../components/ui/Button"
import { flavourForHost, hostFromHeaders } from "../lib/app-host"

export const metadata: Metadata = {
  title: "Pair your iPhone",
  description:
    "Open this link on an iPhone with Agent Workspace installed to pair it with your Mac.",
  robots: { index: false, follow: false },
}

// TODO(owner): set this to the Agent Workspace App Store URL once the app is listed.
// While it is null the page says "Coming soon to the App Store".
export const APP_STORE_URL: string | null = null

// The pairing secret travels in the URL fragment. A fragment never reaches a
// server, and this page ships no script and does not read it. The installed
// app receives the whole link as a universal link (see the association file).
export default async function Page() {
  const flavour = flavourForHost(hostFromHeaders(await headers())) ?? "prod"
  return (
    <AppPage>
      <h1>Pair your iPhone</h1>
      <p>
        Open this page on an iPhone that has Agent Workspace installed. The app opens and starts
        pairing with your Mac. If it does not open, scan the code on your Mac's "Add your iPhone"
        screen again, or use the iPhone's Camera.
      </p>
      {flavour === "beta" ? (
        <p>This build is distributed through TestFlight by invitation.</p>
      ) : flavour === "local" ? (
        <p>This is a development build. Run the iOS app from Xcode on your own device.</p>
      ) : APP_STORE_URL ? (
        <p>
          <Button href={APP_STORE_URL}>Get Agent Workspace on the App Store</Button>
        </p>
      ) : (
        <p>Coming soon to the App Store</p>
      )}
    </AppPage>
  )
}
