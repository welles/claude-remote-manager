import type { PreviewDto } from '@claude-remote-manager/shared-types';

export const PREVIEW_ID = '3f0c9a6e-2b1d-4c5e-8f7a-9b0c1d2e3f4a';

/** A running preview of session `s1`. */
export const preview = (overrides: Partial<PreviewDto> = {}): PreviewDto => ({
  id: PREVIEW_ID,
  sessionId: 's1',
  port: 5173,
  name: 'Web app',
  url: 'https://demo-abc123-5173.preview.example.com/',
  state: 'running',
  problem: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  stoppedAt: null,
  stoppedBy: null,
  ...overrides,
});
