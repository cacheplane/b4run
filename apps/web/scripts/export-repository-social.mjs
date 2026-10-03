import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const fontDir = resolve(root, "apps/web/public/brand/identity/fonts")
const output = resolve(root, "docs/brand/b4-repository-social")
const temp = await mkdtemp(join(tmpdir(), "b4-social-"))
const escapeXml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
const logo = await readFile(
  resolve(root, "apps/web/public/brand/identity/logos/wordmark-ink.svg"),
  "utf8",
)
const logoBody = logo.slice(logo.indexOf(">") + 1, logo.lastIndexOf("</svg>"))
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-labelledby="title desc">
<title id="title">B4.run: Ridiculous speed. Readable code.</title>
<desc id="desc">An agent framework, the way I'd build it. Paper Relay repository social card.</desc>
<rect width="1280" height="640" fill="#f5f4f0"/>
<svg x="72" y="56" width="194" height="43" viewBox="-5 -5 522 115">${logoBody}</svg>
<g font-family="Inter, sans-serif" font-weight="600" fill="#111111">
<text x="72" y="270" font-size="88" letter-spacing="-4">Ridiculous speed.</text>
<text x="72" y="365" font-size="88" letter-spacing="-4">Readable code.</text>
<text x="72" y="556" font-size="24">An agent framework, the way I'd build it.</text>
<text x="1100" y="556" font-size="24">b4.run</text>
</g>
<circle cx="1124" cy="280" r="54" fill="#b4ce37"/>
<path d="M72 510H1208" stroke="#d6d6cc"/>
</svg>\n`
try {
  // Use the checked-in fonts, not whichever fonts happen to be installed locally.
  const config = join(temp, "fonts.conf")
  await writeFile(
    config,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>${escapeXml(fontDir)}</dir><cachedir>${escapeXml(temp)}</cachedir></fontconfig>`,
  )
  process.env.FONTCONFIG_FILE = config
  const { default: sharp } = await import("sharp")
  await writeFile(`${output}.svg`, svg)
  await sharp(Buffer.from(svg)).png().toFile(`${output}.png`)
  console.log("Wrote docs/brand/b4-repository-social.svg and .png (1280×640)")
} finally {
  await rm(temp, { recursive: true, force: true })
}
