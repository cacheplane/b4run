import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react"

type Variant = "primary" | "secondary" | "ghost"

interface Common {
  readonly children: ReactNode
  readonly variant?: Variant
  /** `sm` is the mono 2rem control; `icon` is a 44px square for an icon-only control (give it an aria-label). */
  readonly size?: "sm" | "icon"
  readonly className?: string
}
interface LinkButton
  extends Common,
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children" | "href"> {
  readonly href: string
  readonly ref?: Ref<HTMLAnchorElement>
}
interface RealButton
  extends Common,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  readonly href?: undefined
  readonly ref?: Ref<HTMLButtonElement>
}

/**
 * Square, ink-bordered. Renders <a> when given an href (plain anchor: the
 * homepage and 404 link to files and anchors next/link does not handle).
 * Forwards every other anchor or button attribute, including `ref`.
 */
export function Button(props: LinkButton | RealButton) {
  const { children, variant = "primary", size, className } = props
  const shared = {
    "data-ui": "button",
    "data-variant": variant,
    ...(size ? { "data-size": size } : {}),
    ...(className ? { className } : {}),
  }
  if (props.href !== undefined) {
    const { href, variant: _v, size: _s, className: _c, children: _ch, ...rest } = props
    return (
      <a {...shared} href={href} {...rest}>
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
