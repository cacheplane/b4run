import type {
  BlogPostingSeoPage,
  CollectionPageSeoPage,
  SeoPage,
  TechArticleSeoPage,
  WebPageSeoPage,
} from "./types"

const SITE_URL = "https://b4.run/"
const ORGANIZATION_ID = `${SITE_URL}#organization`
const WEBSITE_ID = `${SITE_URL}#website`
const LOGO_ID = `${SITE_URL}#logo`

interface EntityReference {
  readonly "@id": string
}

interface TechArticleJsonLd {
  readonly "@context": "https://schema.org"
  readonly "@type": "TechArticle"
  readonly "@id": string
  readonly headline: string
  readonly description: string
  readonly url: string
  readonly dateModified: string
  readonly author: EntityReference
  readonly publisher: EntityReference
  readonly isPartOf: EntityReference
}

interface BreadcrumbListItemJsonLd {
  readonly "@type": "ListItem"
  readonly position: number
  readonly name: string
  readonly item?: string
}

interface BreadcrumbListJsonLd {
  readonly "@context": "https://schema.org"
  readonly "@type": "BreadcrumbList"
  readonly "@id": string
  readonly itemListElement: readonly BreadcrumbListItemJsonLd[]
}

export function siteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION_ID,
        name: "B4.run",
        url: SITE_URL,
        logo: {
          "@type": "ImageObject",
          "@id": LOGO_ID,
          url: `${SITE_URL}brand/b4-logo-horizontal-black.svg`,
        },
      },
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        name: "B4.run",
        url: SITE_URL,
        publisher: { "@id": ORGANIZATION_ID },
      },
    ],
  } as const
}

export function collectionPageJsonLd(page: CollectionPageSeoPage) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": page.canonical,
    url: page.canonical,
    name: page.title,
    description: page.description,
    isPartOf: { "@id": WEBSITE_ID },
    breadcrumb: { "@id": `${page.canonical}#breadcrumb` },
  } as const
}

export function webPageJsonLd(page: WebPageSeoPage) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${page.canonical}#webpage`,
    url: page.canonical,
    name: page.title,
    description: page.description,
    isPartOf: { "@id": WEBSITE_ID },
    publisher: { "@id": ORGANIZATION_ID },
  } as const
}

/**
 * The post's social card: an explicit `ogImage` when the post sets one,
 * otherwise its co-located `opengraph-image` route. Next appends a
 * content-hash query to the metadata URL; the bare route serves the same PNG.
 */
function blogPostingImage(page: BlogPostingSeoPage): string {
  return page.socialImage !== undefined
    ? new URL(page.socialImage, page.canonical).href
    : `${page.canonical}/opengraph-image`
}

export function blogPostingJsonLd(page: BlogPostingSeoPage) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${page.canonical}#article`,
    headline: page.title,
    description: page.description,
    url: page.canonical,
    datePublished: page.datePublished,
    dateModified: page.lastModified,
    image: blogPostingImage(page),
    author: {
      "@type": "Person",
      "@id": page.author.url,
      name: page.author.name,
      url: page.author.url,
      image: new URL(page.author.avatar, SITE_URL).href,
    },
    publisher: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
  } as const
}

export function techArticleJsonLd(page: TechArticleSeoPage): TechArticleJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": page.kind,
    "@id": `${page.canonical}#article`,
    headline: page.title,
    description: page.description,
    url: page.canonical,
    dateModified: page.lastModified,
    // The docs are written and published by the project, not one person.
    author: { "@id": ORGANIZATION_ID },
    publisher: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
  }
}

/** The visible trail minus unlinked ancestors; the final crumb always stays. */
export function structuredBreadcrumbs<T extends { readonly href?: string }>(
  crumbs: readonly T[],
): readonly T[] {
  return crumbs.filter((crumb, index) => crumb.href !== undefined || index === crumbs.length - 1)
}

export function breadcrumbJsonLd(page: SeoPage): BreadcrumbListJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${page.canonical}#breadcrumb`,
    // An unlinked ancestor (a docs nav section label) has no URL to give, and
    // every ancestor ListItem needs one, so the list keeps linked ancestors.
    itemListElement: structuredBreadcrumbs(page.breadcrumbs).map((crumb, index, crumbs) => {
      const item = crumb.href
        ? new URL(crumb.href, page.canonical).href
        : page.kind !== "TechArticle" && index === crumbs.length - 1
          ? page.canonical
          : undefined

      return {
        "@type": "ListItem",
        position: index + 1,
        name: crumb.label,
        ...(item !== undefined ? { item } : {}),
      }
    }),
  }
}
