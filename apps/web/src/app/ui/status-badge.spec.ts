import { statusKind } from './status-badge';

describe('statusKind', () => {
  it('shows background tasks as running, a finished turn as idle', () => {
    expect(statusKind({ status: 'waiting', waitingFor: 'background' })).toBe(
      'running',
    );
    expect(statusKind({ status: 'waiting', waitingFor: 'message' })).toBe(
      'idle',
    );
    expect(statusKind({ status: 'waiting', waitingFor: 'permission' })).toBe(
      'attention',
    );
  });

  it('tells the remaining states apart', () => {
    expect(statusKind({ status: 'preparing', waitingFor: null })).toBe(
      'running',
    );
    expect(statusKind({ status: 'waiting', waitingFor: 'setup' })).toBe(
      'attention',
    );
    expect(statusKind({ status: 'failed', waitingFor: null })).toBe('failed');
    expect(statusKind({ status: 'finished', waitingFor: null })).toBe('done');
    expect(
      statusKind({
        status: 'waiting',
        waitingFor: 'message',
        archivedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('done');
    // Still blocked on the user, archived or not.
    expect(
      statusKind({
        status: 'waiting',
        waitingFor: 'permission',
        archivedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('attention');
  });
});
