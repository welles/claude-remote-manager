/**
 * The IANA time zone `value` (the server's `TZ`) names, or `UTC` when it is
 * not set or not a valid IANA time zone.
 */
export function serverTimeZone(value: string | undefined): string {
  const zone = value?.trim();
  if (!zone) {
    return 'UTC';
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}
