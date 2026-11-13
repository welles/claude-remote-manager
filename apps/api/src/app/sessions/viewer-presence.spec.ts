import { PRESENCE_TIMEOUT_MS } from '@claude-remote-manager/shared-types';
import { ViewerPresence } from './viewer-presence';

describe('ViewerPresence', () => {
  let now: number;
  let presence: ViewerPresence;

  beforeEach(() => {
    now = 1_000_000;
    presence = new ViewerPresence(() => now);
  });

  it('counts a client only while it is active and repeats it in time', () => {
    const phone = {};
    presence.update(phone, 's1', true);
    expect(presence.isViewed('s1')).toBe(true);
    expect(presence.isViewed('s2')).toBe(false);
    // The page froze in a pocket: no repetition.
    now += PRESENCE_TIMEOUT_MS + 1;
    expect(presence.isViewed('s1')).toBe(false);
    presence.update(phone, 's1', true);
    expect(presence.isViewed('s1')).toBe(true);
    presence.update(phone, 's1', false);
    expect(presence.isViewed('s1')).toBe(false);
  });

  it('forgets disconnected clients and looks at all of them', () => {
    const desktop = {};
    const phone = {};
    presence.update(desktop, 's1', true);
    presence.update(phone, null, true);
    expect(presence.isViewed('s1')).toBe(true);
    presence.remove(desktop);
    expect(presence.isViewed('s1')).toBe(false);
  });
});
