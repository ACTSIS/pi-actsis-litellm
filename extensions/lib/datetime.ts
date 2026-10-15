/** Display an instant in the host system zone, without changing stored UTC data. */
export function formatLocalDateTime(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  // Resolve per call: use the system zone and the offset at this instant (DST-aware).
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? "";
  const offset = part("timeZoneName").replace(/^GMT$/, "GMT+00:00");
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} (${formatter.resolvedOptions().timeZone}, ${offset})`;
}
