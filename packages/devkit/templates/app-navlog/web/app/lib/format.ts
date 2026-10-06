export const formatHeading = (deg: number): string => String(Math.round(deg)).padStart(3, "0")

/** Minutes as h:mm. Rounds to whole minutes first, so 59.6 is 1:00, never 0:60. */
export const formatHhmm = (minutes: number): string => {
  const total = Math.round(minutes)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

export const formatUtcHhmm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}Z`
}

export const formatGal = (gal: number): string => gal.toFixed(1)

/** Signed variation (east positive) as `3E` / `2W`; zero is `0`. */
export const formatVariation = (deg: number): string =>
  deg === 0 ? "0" : `${Math.abs(deg)}${deg < 0 ? "W" : "E"}`

/** Feet with a thousands separator: `5,500 ft`. */
export const formatFeet = (ft: number): string => `${Math.round(ft).toLocaleString("en-US")} ft`
