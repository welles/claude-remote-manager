import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { AppSettingsDto } from '@claude-remote-manager/shared-types';
import {
  APP_CONFIG,
  GIT_AUTHOR_EMAIL_VARIABLE,
  GIT_AUTHOR_NAME_VARIABLE,
  type AppConfig,
} from '../config/app-config';
import type { GitIdentity } from '../git/git-auth';

/** Message when a session or project needs the commit identity. */
export const IDENTITY_REQUIRED = `Set the git author name and email with the API's environment variables ${GIT_AUTHOR_NAME_VARIABLE} and ${GIT_AUTHOR_EMAIL_VARIABLE} first: commits in session clones are made with them`;

/**
 * Settings of the app that the Settings page shows. The commit identity
 * comes from the environment (see `AppConfig.gitIdentity`) and cannot be
 * changed at runtime.
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get(): AppSettingsDto {
    const identity = this.gitIdentity();
    return {
      gitAuthorName: identity?.name ?? null,
      gitAuthorEmail: identity?.email ?? null,
    };
  }

  /** The commit identity, or `null` if not configured. */
  gitIdentity(): GitIdentity | null {
    return this.config.gitIdentity;
  }

  /** The commit identity; 409 with an explanation if it is not set. */
  requireGitIdentity(): GitIdentity {
    const identity = this.gitIdentity();
    if (!identity) {
      throw new ConflictException(IDENTITY_REQUIRED);
    }
    return identity;
  }
}
