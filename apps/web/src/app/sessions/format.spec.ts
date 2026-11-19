import { needLabel, statusClass, statusLabel } from './format';

describe('statusClass', () => {
  it('marks every session that needs the user', () => {
    expect(statusClass({ status: 'waiting', waitingFor: 'permission' })).toBe(
      'status-permission',
    );
    expect(statusClass({ status: 'waiting', waitingFor: 'setup' })).toBe(
      'status-permission',
    );
    expect(statusLabel({ status: 'waiting', waitingFor: 'setup' })).toBe(
      'Setup failed',
    );
  });

  it('keeps the plain status otherwise', () => {
    expect(statusClass({ status: 'waiting', waitingFor: 'message' })).toBe(
      'status-waiting',
    );
    expect(statusClass({ status: 'failed', waitingFor: null })).toBe(
      'status-failed',
    );
  });
});

describe('statusLabel', () => {
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
  });
});
