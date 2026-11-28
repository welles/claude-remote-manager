import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  AGENT_ENGINES,
  DEFAULT_REVIEW_EFFORT,
  DEFAULT_REVIEW_ENGINE,
  DEFAULT_REVIEW_MODEL,
  DEFAULT_REVIEW_MODELS,
  ENGINE_LABELS,
  ENGINE_REVIEW_EFFORTS,
  REVIEW_EFFORTS,
  reviewEffortFor,
  type AgentEngineId,
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

/**
 * An effort of a request for a reviewer of `engine`; 400 when it is not
 * one the engine offers.
 */
export function requireReviewEffort(
  value: unknown,
  field: string,
  engine: AgentEngineId = DEFAULT_REVIEW_ENGINE,
): ReviewEffort {
  const offered = ENGINE_REVIEW_EFFORTS[engine] ?? REVIEW_EFFORTS;
  if (!(offered as readonly unknown[]).includes(value)) {
    throw new BadRequestException(
      `${field} must be one of ${offered.join(', ')}${engine === DEFAULT_REVIEW_ENGINE ? '' : ` (${ENGINE_LABELS[engine]})`}`,
    );
  }
  return value as ReviewEffort;
}

export function isAgentEngine(value: unknown): value is AgentEngineId {
  return (AGENT_ENGINES as readonly unknown[]).includes(value);
}

/**
 * A reviewer's engine of a request: 400 when it is no engine, 409 when
 * this server does not have it.
 */
export function requireReviewEngine(
  value: unknown,
  field: string,
  available: (engine: AgentEngineId) => boolean,
): AgentEngineId {
  if (!isAgentEngine(value)) {
    throw new BadRequestException(
      `${field} must be one of ${AGENT_ENGINES.join(', ')}`,
    );
  }
  if (!available(value)) {
    throw new ConflictException(
      `The engine ${ENGINE_LABELS[value]} is not available on this server`,
    );
  }
  return value;
}

/** A stored model, if it is one. */
function storedModel(value: unknown): string | null {
  return typeof value === 'string' && MODEL_PATTERN.test(value) ? value : null;
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
    const models =
      typeof stored['models'] === 'object' && stored['models'] !== null
        ? (stored['models'] as Record<string, unknown>)
        : {};
    // Before Codex the settings had one model, Claude Code's (`model`).
    // A stored `maxAutoRounds` (the former round limit) is ignored.
    return {
      engine: isAgentEngine(stored['engine'])
        ? stored['engine']
        : DEFAULT_REVIEW_ENGINE,
      models: Object.fromEntries(
        AGENT_ENGINES.map((engine) => [
          engine,
          storedModel(models[engine]) ??
            (engine === 'claude-code' ? storedModel(stored['model']) : null) ??
            DEFAULT_REVIEW_MODELS[engine],
        ]),
      ) as Record<AgentEngineId, string | null>,
      effort: isReviewEffort(stored['effort'])
        ? stored['effort']
        : DEFAULT_REVIEW_EFFORT,
    };
  }

  /**
   * Changes the settings; `available` says which engines the server has
   * (only those can be chosen).
   */
  update(
    request: UpdateReviewDefaultsRequest,
    available: (engine: AgentEngineId) => boolean = (engine) =>
      engine === DEFAULT_REVIEW_ENGINE,
    now = new Date(),
  ): ReviewDefaults {
    const body = requireObject(request);
    const next = this.get();
    if (body['engine'] !== undefined) {
      next.engine = requireReviewEngine(body['engine'], 'engine', available);
      // An effort the new engine does not offer becomes the closest one.
      next.effort = reviewEffortFor(next.engine, next.effort);
    }
    if (body['model'] !== undefined) {
      next.models[next.engine] =
        body['model'] === null
          ? DEFAULT_REVIEW_MODELS[next.engine]
          : requireReviewModel(body['model'], 'model');
    }
    if (body['effort'] !== undefined) {
      next.effort = requireReviewEffort(body['effort'], 'effort', next.engine);
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
