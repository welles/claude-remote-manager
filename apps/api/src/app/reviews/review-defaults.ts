import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_REVIEW_EFFORT,
  DEFAULT_REVIEW_MODEL,
  REVIEW_EFFORTS,
  type ReviewDefaults,
  type ReviewEffort,
  type UpdateReviewDefaultsRequest,
} from '@claude-remote-manager/shared-types';
import { requireObject } from '../common/validation';
import { DATABASE, type AppDatabase } from '../db/database';
import { appSettings } from '../db/schema';

/** Key of the review settings in `app_settings`. */
export const REVIEW_DEFAULTS_KEY = 'review';

/**
 * A model name or alias as Claude Code takes it (`opus`, `claude-fable-5-2`,
 * `sonnet[1m]`): it also goes into the app's message to Claude, which may
 * contain no `@`.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;

export function isReviewEffort(value: unknown): value is ReviewEffort {
  return (REVIEW_EFFORTS as readonly unknown[]).includes(value);
}

/** A model of a request; 400 when it is not one. */
export function requireReviewModel(value: unknown, field: string): string {
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value.trim())) {
    throw new BadRequestException(
      `${field} must be a model name or alias such as ${DEFAULT_REVIEW_MODEL} or opus`,
    );
  }
  return value.trim();
}

/** An effort of a request; 400 when it is not one. */
export function requireReviewEffort(
  value: unknown,
  field: string,
): ReviewEffort {
  if (!isReviewEffort(value)) {
    throw new BadRequestException(
      `${field} must be one of ${REVIEW_EFFORTS.join(', ')}`,
    );
  }
  return value;
}

/** The app's review settings, stored in `app_settings`. */
@Injectable()
export class ReviewDefaultsStore {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  get(): ReviewDefaults {
    const row = this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, REVIEW_DEFAULTS_KEY))
      .get();
    const stored = (row?.value ?? {}) as Record<string, unknown>;
    const model = stored['model'];
    // A stored `maxAutoRounds` (the former round limit) is ignored.
    return {
      model:
        typeof model === 'string' && MODEL_PATTERN.test(model)
          ? model
          : DEFAULT_REVIEW_MODEL,
      effort: isReviewEffort(stored['effort'])
        ? stored['effort']
        : DEFAULT_REVIEW_EFFORT,
    };
  }

  update(
    request: UpdateReviewDefaultsRequest,
    now = new Date(),
  ): ReviewDefaults {
    const body = requireObject(request);
    const next = this.get();
    if (body['model'] !== undefined) {
      next.model = requireReviewModel(body['model'], 'model');
    }
    if (body['effort'] !== undefined) {
      next.effort = requireReviewEffort(body['effort'], 'effort');
    }
    this.db
      .insert(appSettings)
      .values({ key: REVIEW_DEFAULTS_KEY, value: next, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: next, updatedAt: now },
      })
      .run();
    return next;
  }
}
