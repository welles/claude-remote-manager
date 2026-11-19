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
});
