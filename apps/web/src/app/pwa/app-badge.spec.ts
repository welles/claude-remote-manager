import { sessionDto } from '../sessions/testing/session-dto';
import { needsUserCount, setBadge } from './app-badge';

describe('app badge', () => {
  it('counts only sessions blocked on the user', () => {
    expect(
      needsUserCount([
        sessionDto({ id: 'a', status: 'waiting', waitingFor: 'permission' }),
        sessionDto({ id: 'b', status: 'waiting', waitingFor: 'setup' }),
        sessionDto({ id: 'c', status: 'waiting', waitingFor: 'message' }),
        sessionDto({ id: 'd', status: 'running', waitingFor: null }),
        sessionDto({ id: 'e', status: 'failed', waitingFor: null }),
      ]),
    ).toBe(2);
  });

  it('sets or clears the badge', () => {
    const target = {
      setAppBadge: vi.fn(async () => undefined),
      clearAppBadge: vi.fn(async () => undefined),
    } as unknown as Navigator;
    setBadge(3, target);
    setBadge(0, target);
    expect(target.setAppBadge).toHaveBeenCalledWith(3);
    expect(target.clearAppBadge).toHaveBeenCalledTimes(1);
  });
});
