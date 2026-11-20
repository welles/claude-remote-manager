import { needLabel, statusLabel } from './format';

describe('statusLabel', () => {
  it('names a failed setup script', () => {
    expect(statusLabel({ status: 'waiting', waitingFor: 'setup' })).toBe(
      'Setup failed',
    );
  });

  it('tells ready from waiting for background tasks', () => {
    expect(statusLabel({ status: 'waiting', waitingFor: 'message' })).toBe(
      'Ready',
    );
    expect(statusLabel({ status: 'waiting', waitingFor: 'background' })).toBe(
      'Background',
    );
    expect(
      needLabel({
        status: 'waiting',
        waitingFor: 'background',
        backgroundTasks: 2,
      }),
    ).toBe('2 background tasks');
    expect(
      needLabel({
        status: 'waiting',
        waitingFor: 'background',
        backgroundTasks: 1,
      }),
    ).toBe('1 background task');
    expect(
      needLabel({
        status: 'waiting',
        waitingFor: 'background',
        backgroundTasks: 1,
        waitingReason: 'CI of PR #12',
      }),
    ).toBe('CI of PR #12');
  });
});
