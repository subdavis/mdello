const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function formatStamp(value: string | number | undefined): string {
  if (value === undefined || value === '') return '—';

  // A bare YYYY-MM-DD parses as UTC midnight, which renders as the previous day in
  // timezones west of Greenwich; read it as a local calendar date instead.
  const dateMatch = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateMatch) {
    const [, year, month, day] = dateMatch.map(Number);
    const local = new Date(year, month - 1, day);
    // The Date constructor rolls invalid components over; only a clean round-trip counts.
    if (local.getMonth() === month - 1 && local.getDate() === day) return dateOnly.format(local);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);

  // Date-only frontmatter has no meaningful time component to show.
  const hasTime = typeof value === 'number' || /[T ]\d{2}:\d{2}/.test(value);
  return hasTime ? dateTime.format(parsed) : dateOnly.format(parsed);
}
