export const formatHeading = (deg: number): string => String(Math.round(deg)).padStart(3, "0")

export const formatHhmm = (minutes: number): string =>
  `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, "0")}`

export const formatUtcHhmm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}Z`
}

export const formatGal = (gal: number): string => gal.toFixed(1)
