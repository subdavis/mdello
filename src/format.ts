const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function formatStamp(value: string | number | undefined): string {
  if (value === undefined || value === '') return '—';

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);

  // Date-only frontmatter has no meaningful time component to show.
  const hasTime = typeof value === 'number' || /[T ]\d{2}:\d{2}/.test(value);
  return hasTime ? dateTime.format(parsed) : dateOnly.format(parsed);
}
