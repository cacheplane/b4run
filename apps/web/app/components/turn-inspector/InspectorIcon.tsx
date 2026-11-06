/** Functional transport icons; the enclosing control provides its accessible name. */
export function InspectorIcon({
  name,
}: {
  name: "previous" | "next" | "first" | "last" | "play" | "pause" | "tool"
}) {
  const paths = {
    previous: "m14 6-6 6 6 6",
    next: "m10 6 6 6-6 6",
    first: "M6 5v14m12-13-8 6 8 6",
    last: "M18 5v14M6 6l8 6-8 6",
    play: "m9 5 11 7-11 7Z",
    pause: "M8 5v14M16 5v14",
    tool: "m8 6-6 6 6 6m8-12 6 6-6 6",
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill={name === "play" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
