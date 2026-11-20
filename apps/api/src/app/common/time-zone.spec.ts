import { serverTimeZone } from './time-zone';

describe('serverTimeZone', () => {
  it('returns the IANA zone TZ names', () => {
    expect(serverTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(serverTimeZone(' Europe/Berlin ')).toBe('Europe/Berlin');
  });

  it('falls back to UTC without a valid zone', () => {
    expect(serverTimeZone(undefined)).toBe('UTC');
    expect(serverTimeZone('')).toBe('UTC');
    expect(serverTimeZone('Not/AZone')).toBe('UTC');
  });
});
