export const SEQUENCE_TIME_ZONE = "America/Los_Angeles"

/** Business days after the previous send before each later step is due. */
export const STEP_DELAY_BUSINESS_DAYS: Readonly<Record<2 | 3, number>> = {
  2: 3,
  3: 5,
}

const calendar = new Intl.DateTimeFormat("en-US", {
  timeZone: SEQUENCE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
})

function parts(date: Date) {
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid sequence date")
  }
  const values = Object.fromEntries(
    calendar.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
  }
}

function isWeekday(day: Date): boolean {
  return day.getUTCDay() !== 0 && day.getUTCDay() !== 6
}

/** 07:00 Pacific on the Nth weekday after the anchor's Pacific date. */
export function businessMorningAfter(anchor: Date, businessDays: number): Date {
  if (!Number.isSafeInteger(businessDays) || businessDays < 1 || businessDays > 366) {
    throw new Error("Invalid business-day offset")
  }
  const local = parts(anchor)
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day))
  let remaining = businessDays
  while (remaining > 0) {
    day.setUTCDate(day.getUTCDate() + 1)
    if (isWeekday(day)) remaining--
  }
  // 15:00 UTC is 07:00 or 08:00 Pacific. Resolve the target date's own
  // offset, not the anchor's, so crossing DST preserves the local hour.
  day.setUTCHours(15)
  day.setUTCHours(day.getUTCHours() + 7 - parts(day).hour)
  return day
}

/** True on a Pacific weekday during local hour 7. */
export function isSendWindow(now: Date): boolean {
  const local = parts(now)
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day))
  return isWeekday(day) && local.hour === 7
}

/** The Pacific calendar date for `now`, and whether it is Monday to Friday. */
export function pacificCalendarDate(now: Date): {
  date: string
  weekday: boolean
} {
  const local = parts(now)
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day))
  const pad = (value: number) => String(value).padStart(2, "0")
  return {
    date: `${local.year}-${pad(local.month)}-${pad(local.day)}`,
    weekday: isWeekday(day),
  }
}
