/**
 * The workbench's one icon set: 24×24 viewBox, 2px stroke, round caps and
 * joins, drawn in `currentColor`. Decorative everywhere (`aria-hidden`): the
 * control that holds an icon carries the accessible name.
 */
const PATHS = {
  plus: "M12 5v14M5 12h14",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  sidebar: "M4 5h16v14H4zM9 5v14",
  memory: "M6 4h12v16l-6-4-6 4z",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  navlog: "M4 6h16M4 12h16M4 18h10",
} as const

export type IconName = keyof typeof PATHS

/** One icon from the set, decorative (`aria-hidden`). */
export function Icon({
  name,
  className = "size-5",
}: {
  readonly name: IconName
  readonly className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
