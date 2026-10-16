import type { Label } from '../types/board';
import { labels } from './useBoard';

export type { Label };
export { labels };

/** Picker palette: five hues in three shades, laid out five per row. */
export const PALETTE = [
  '#baf3db',
  '#f8e6a0',
  '#ffd5d2',
  '#dfd8fd',
  '#cce0ff',
  '#4bce97',
  '#f5cd47',
  '#f87168',
  '#9f8fef',
  '#579dff',
  '#1f845a',
  '#946f00',
  '#c9372c',
  '#6e5dc6',
  '#0c66e4',
];

function labelColor(tag: string): string | undefined {
  return labels.value.find((label) => label.name === tag)?.color;
}

/** Readable ink for a swatch: white on dark colours, board ink on light ones. */
function textOn(color: string): string {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];

  return luminance > 0.3 ? '#172b4d' : '#fff';
}

export function chipStyle(color: string): Record<string, string> {
  return { background: color, color: textOn(color) };
}

/** Tags matching a label are tinted; anything else keeps the plain chip styling. */
export function tagStyle(tag: string): Record<string, string> {
  const color = labelColor(tag);
  return color ? chipStyle(color) : {};
}
