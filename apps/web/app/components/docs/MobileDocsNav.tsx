"use client"

import { DocsNavGroups } from "./DocsNavGroups"

interface Props {
  readonly pathname: string
  readonly onNavigate: () => void
}

export function MobileDocsNav({ pathname, onNavigate }: Props) {
  return <DocsNavGroups pathname={pathname} variant="menu" onNavigate={onNavigate} />
}
