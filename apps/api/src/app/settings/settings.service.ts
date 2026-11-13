import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Subject } from 'rxjs';
import type {
  AppSettingsDto,
  UpdateSettingsRequest,
} from '@claude-remote-manager/shared-types';
import { requireObject } from '../common/validation';
import { DATABASE, type AppDatabase } from '../db/database';
import { appSettings } from '../db/schema';
import type { GitIdentity } from '../git/git-auth';

const DEFAULTS: AppSettingsDto = {
  gitAuthorName: null,
  gitAuthorEmail: null,
};

const KEYS = Object.keys(DEFAULTS) as (keyof AppSettingsDto)[];

/** Message when a session or project needs the commit identity. */
export const IDENTITY_REQUIRED =
  'Set the git author name and email on the Settings page first: commits in session clones are made with them';

/** Simple shape check; git accepts anything without newlines and <>. */
const EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+$/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_NAME = /[<>\u0000-\u001f\u007f]/;

function parseName(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('gitAuthorName must be a string or null');
  }
  const name = value.trim();
  if (!name) {
    return null;
  }
  if (name.length > 200 || FORBIDDEN_IN_NAME.test(name)) {
    throw new BadRequestException(
      'gitAuthorName must be at most 200 characters without <, > or control characters',
    );
  }
  return name;
}

function parseEmail(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('gitAuthorEmail must be a string or null');
  }
  const email = value.trim();
  if (!email) {
    return null;
  }
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new BadRequestException('gitAuthorEmail is not an email address');
  }
  return email;
}

/**
 * Settings stored in the database. Later steps add their settings here
 * (e.g. notifications); listeners of {@link changes$} react to updates,
 * e.g. the commit identity is applied to all session clones.
 */
@Injectable()
export class SettingsService {
  private readonly changes = new Subject<{
    before: AppSettingsDto;
    after: AppSettingsDto;
  }>();
  readonly changes$ = this.changes.asObservable();

  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  get(): AppSettingsDto {
    const settings: AppSettingsDto = { ...DEFAULTS };
    for (const row of this.db.select().from(appSettings).all()) {
      if ((KEYS as string[]).includes(row.key)) {
        (settings as unknown as Record<string, unknown>)[row.key] = row.value;
      }
    }
    return settings;
  }

  update(request: UpdateSettingsRequest, now = new Date()): AppSettingsDto {
    const body = requireObject(request);
    const unknown = Object.keys(body).filter(
      (key) => !(KEYS as string[]).includes(key),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown settings: ${unknown.join(', ')}`);
    }
    const before = this.get();
    const patch: Partial<AppSettingsDto> = {};
    if ('gitAuthorName' in body) {
      patch.gitAuthorName = parseName(body['gitAuthorName']);
    }
    if ('gitAuthorEmail' in body) {
      patch.gitAuthorEmail = parseEmail(body['gitAuthorEmail']);
    }
    const after = { ...before, ...patch };
    if ((after.gitAuthorName === null) !== (after.gitAuthorEmail === null)) {
      throw new BadRequestException(
        'Set both the git author name and email, or neither',
      );
    }
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          tx.delete(appSettings).where(eq(appSettings.key, key)).run();
        } else {
          tx.insert(appSettings)
            .values({ key, value, updatedAt: now })
            .onConflictDoUpdate({
              target: appSettings.key,
              set: { value, updatedAt: now },
            })
            .run();
        }
      }
    });
    this.changes.next({ before, after });
    return after;
  }

  /** The commit identity, or `null` if not configured. */
  gitIdentity(): GitIdentity | null {
    const { gitAuthorName, gitAuthorEmail } = this.get();
    return gitAuthorName && gitAuthorEmail
      ? { name: gitAuthorName, email: gitAuthorEmail }
      : null;
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
