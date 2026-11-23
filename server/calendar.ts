export const closeProximityDays = 7;
export const accountActivityDays = 21;

export function calendarDay(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp / 86_400_000
    : NaN;
}
