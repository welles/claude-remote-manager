/**
 * Settings of the app shown on the Settings page, read-only: they come from
 * the API's environment. Secrets (GitHub App key, tokens) are never
 * settings.
 */
export interface AppSettingsDto {
  /**
   * Author of the commits in session clones (the user, not the GitHub
   * App), from `CRM_GIT_AUTHOR_NAME` and `CRM_GIT_AUTHOR_EMAIL`. Sessions
   * with repositories cannot start while it is unset.
   */
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  /**
   * The server's IANA time zone, from `TZ` (`UTC` when unset or invalid),
   * e.g. for showing the server's build time.
   */
  timeZone: string;
}
