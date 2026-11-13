import type { ShownFileDto } from '@claude-remote-manager/shared-types';

/** A shown file as the server sends it, for tests. */
export const shownFile = (
  overrides: Partial<ShownFileDto> = {},
): ShownFileDto => ({
  id: '11111111-2222-4333-8444-555555555555',
  origin: 'show_file',
  path: '/w/app/out/report.md',
  name: 'report.md',
  caption: null,
  kind: 'markdown',
  mediaType: 'text/plain; charset=utf-8',
  language: 'markdown',
  size: 1234,
  snapshot: true,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});
