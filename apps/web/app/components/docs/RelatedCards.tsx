import { Card } from "../ui/Card"
import { Icon } from "../ui/Icon"

export interface RelatedCardItem {
  readonly href: string
  readonly title: string
  readonly subtitle?: string
}

interface RelatedCardsProps {
  readonly items: ReadonlyArray<RelatedCardItem>
}

export function RelatedCards({ items }: RelatedCardsProps) {
  return (
    <div data-related-cards className="not-prose grid grid-cols-1 md:grid-cols-2 gap-3 my-6">
      {items.map((item) => (
        <Card key={item.href} href={item.href} className="group relative px-4 py-3">
          <span className="absolute top-[17px] right-3 text-ink-muted group-hover:text-ink transition-colors">
            <Icon
              name="arrowUpRight"
              className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            />
          </span>
          <div className="pr-6">
            <div className="text-base font-semibold text-ink">{item.title}</div>
            {item.subtitle && (
              <div className="mt-1 text-sm text-ink-muted leading-snug">{item.subtitle}</div>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}
