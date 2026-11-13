import { needsUser } from '@claude-remote-manager/shared-types';

describe('badge count (needsUser)', () => {
  it.each([
    ['waiting', 'permission', true],
    ['waiting', 'setup', true],
    ['waiting', 'message', false],
    ['running', null, false],
    ['preparing', null, false],
    ['finished', null, false],
    ['failed', null, false],
  ] as const)('%s/%s counts: %s', (status, waitingFor, expected) => {
    expect(needsUser({ status, waitingFor })).toBe(expected);
  });
});
