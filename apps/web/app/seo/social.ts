export const SOCIAL_SITE_NAME = "B4.run"
export const SOCIAL_CARD = "summary_large_image"
export const SOCIAL_IMAGE_SIZE = { width: 1200, height: 630 } as const
export const SOCIAL_IMAGE = {
  url: "/opengraph-image",
  type: "image/png",
  ...SOCIAL_IMAGE_SIZE,
  alt: "B4.run: Ridiculous speed. Readable code.",
} as const

/** A docs page's own card, prerendered by app/og/docs/[...slug]/route.tsx. */
export function docsSocialImagePath(path: string): string {
  if (!path.startsWith("/docs/")) throw new Error(`Not a docs page path: ${path}`)
  return `/og${path}`
}

export function docsSocialImage(page: { readonly path: string; readonly title: string }) {
  return {
    url: docsSocialImagePath(page.path),
    type: "image/png",
    ...SOCIAL_IMAGE_SIZE,
    alt: `${page.title} · B4.run docs`,
  } as const
}
