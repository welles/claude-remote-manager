import type { ShownFileDto } from '@claude-remote-manager/shared-types';

/** URL of a shown file's content: the snapshot, or the live file. */
export function shownFileUrl(
  file: ShownFileDto,
  { download = false }: { download?: boolean } = {},
): string {
  const base = `/api/shown-files/${encodeURIComponent(file.id)}/${
    file.snapshot ? 'content' : 'live'
  }`;
  return download ? `${base}?download=1` : base;
}

/** Text larger than this is not rendered or highlighted, only offered. */
export const MAX_RENDERED_TEXT = 2 * 1024 * 1024;

/** Size in a few characters, e.g. `12.3 kB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
