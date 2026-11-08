"use client"

import { DocsNavGroups } from "./DocsNavGroups"
import { DocsSectionSwitcher } from "./DocsSectionSwitcher"

interface Props {
  readonly pathname: string
  readonly onNavigate: () => void
}

export function MobileDocsNav({ pathname, onNavigate }: Props) {
  return (
    <>
      <DocsSectionSwitcher pathname={pathname} onNavigate={onNavigate} />
      <DocsNavGroups pathname={pathname} variant="menu" onNavigate={onNavigate} />
    </>
  )
}
