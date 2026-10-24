// Lima time helpers for the nightly learning jobs. Peru has no DST:
// always UTC-5.

const LIMA_OFFSET_MS = -5 * 60 * 60_000

function limaShifted(now: Date): Date {
  return new Date(now.getTime() + LIMA_OFFSET_MS)
}

/** "YYYY-MM-DD" of `now` in Lima. */
export function limaDateKey(now: Date): string {
  return limaShifted(now).toISOString().slice(0, 10)
}

/** Hour of day (0-23) of `now` in Lima. */
export function limaHour(now: Date): number {
  return limaShifted(now).getUTCHours()
}

/** "YYYY-MM-DD" of the Lima day before `dateKey`. */
export function previousDateKey(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
