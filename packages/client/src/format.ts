const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function formatRelativeStamp(value: string | number | undefined, now = Date.now()): string {
  if (value === undefined || value === '') return '—';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '—';

  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  if (minutes < 43200) return `${Math.floor(minutes / 10080)}w`;
  if (minutes < 525600) return `${Math.floor(minutes / 43200)}mo`;
  return `${Math.floor(minutes / 525600)}y`;
}

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
