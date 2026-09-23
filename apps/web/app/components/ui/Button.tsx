import type { ButtonHTMLAttributes, ReactNode } from "react"

type Variant = "primary" | "secondary" | "ghost"

interface Common {
  readonly children: ReactNode
  readonly variant?: Variant
  readonly size?: "sm"
  readonly className?: string
}
interface LinkButton extends Common {
  readonly href: string
  readonly download?: boolean
}
interface RealButton
  extends Common,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  readonly href?: undefined
}

/** Square, ink-bordered. Renders <a> when given an href (plain anchor: the
    homepage and 404 link to files and anchors next/link does not handle). */
export function Button(props: LinkButton | RealButton) {
  const { children, variant = "primary", size, className } = props
  const shared = {
    "data-ui": "button",
    "data-variant": variant,
    ...(size ? { "data-size": size } : {}),
    ...(className ? { className } : {}),
  }
  if (props.href !== undefined) {
    return (
      <a {...shared} href={props.href} {...(props.download ? { download: true } : {})}>
        {children}
      </a>
    )
  }
  const { href: _href, variant: _v, size: _s, className: _c, children: _ch, ...rest } = props
  return (
    <button type="button" {...shared} {...rest}>
      {children}
    </button>
  )
}
