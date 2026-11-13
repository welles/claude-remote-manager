/**
 * Settings of the app, edited on the Settings page and stored in the
 * database. Secrets (GitHub App key, tokens) are never settings: they come
 * from the environment.
 */
export interface AppSettingsDto {
  /**
   * Author of the commits in session clones (the user, not the GitHub
   * App). Sessions with repositories cannot start while it is unset.
   */
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
}

/** Body of `PUT /api/settings`; fields left out stay unchanged. */
export type UpdateSettingsRequest = Partial<AppSettingsDto>;
