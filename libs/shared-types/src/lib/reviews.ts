import type { AgentEngineId } from './engines';

/*
 * Independent reviews of a session's changes: the app runs a reviewer of
 * its own (a separate, read-only process of the engine the settings
 * choose, Claude Code or Codex, with a model and effort of its own) on
 * the session diff and gives its findings to the session's agent to fix.
 */

/**
 * Reasoning effort of the reviewer: Claude Code's effort levels, which
 * are also Codex's reasoning efforts of the same names.
 */
export type ReviewEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REVIEW_EFFORTS: readonly ReviewEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * The efforts the reviewer of each engine offers, in order. Codex's
 * models list their own reasoning efforts (`none` and `minimal` for
 * some, `ultra` delegates to subagents); the reviewer offers those it
 * shares with Claude Code.
 */
export const ENGINE_REVIEW_EFFORTS: Record<
  AgentEngineId,
  readonly ReviewEffort[]
> = {
  'claude-code': REVIEW_EFFORTS,
  codex: REVIEW_EFFORTS,
};

/**
 * The effort a reviewer of `engine` runs with for `effort`: itself when
 * the engine offers it, else the highest one it offers below it (its
 * lowest when none is).
 */
export function reviewEffortFor(
  engine: AgentEngineId,
  effort: ReviewEffort,
): ReviewEffort {
  const offered = ENGINE_REVIEW_EFFORTS[engine] ?? REVIEW_EFFORTS;
  if (offered.includes(effort)) {
    return effort;
  }
  const rank = REVIEW_EFFORTS.indexOf(effort);
  return (
    [...offered].reverse().find((e) => REVIEW_EFFORTS.indexOf(e) < rank) ??
    offered[0] ??
    effort
  );
}

/** The engine of reviews unless the settings say otherwise. */
export const DEFAULT_REVIEW_ENGINE: AgentEngineId = 'claude-code';

/** Claude Code's reviewer model unless the settings say otherwise. */
export const DEFAULT_REVIEW_MODEL = 'claude-fable-5-2';
export const DEFAULT_REVIEW_EFFORT: ReviewEffort = 'high';

/**
 * The reviewer's model per engine unless the settings say otherwise;
 * `null`: the engine's own default (Codex's default model).
 */
export const DEFAULT_REVIEW_MODELS: Record<AgentEngineId, string | null> = {
  'claude-code': DEFAULT_REVIEW_MODEL,
  codex: null,
};

/**
 * The app's review settings (`GET`/`PUT /api/settings/review`), for every
 * session that does not choose its own engine, model or effort.
 */
export interface ReviewDefaults {
  /**
   * The reviewer's engine. One the server does not have (any more) runs
   * reviews with Claude Code.
   */
  engine: AgentEngineId;
  /**
   * The reviewer's model per engine (name or alias); `null`: the engine's
   * own default. Claude Code's is always set.
   */
  models: Record<AgentEngineId, string | null>;
  effort: ReviewEffort;
}

/**
 * Body of `PUT /api/settings/review`; absent fields stay. `model` is the
 * model of the engine the settings have after the request (`null`: that
 * engine's default model of reviews); `effort` must be one the engine
 * offers. Changing the engine maps a stored effort it does not offer.
 */
export interface UpdateReviewDefaultsRequest {
  engine?: AgentEngineId;
  model?: string | null;
  effort?: ReviewEffort;
}

/** The model of `engine`'s reviewer in the settings. */
export function reviewDefaultModel(
  defaults: ReviewDefaults,
  engine: AgentEngineId,
): string | null {
  return defaults.models?.[engine] ?? DEFAULT_REVIEW_MODELS[engine] ?? null;
}

/** How bad a finding is. */
export type ReviewSeverity = 'high' | 'medium' | 'low';

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  'high',
  'medium',
  'low',
];

/** One finding of the reviewer. */
export interface ReviewFinding {
  severity: ReviewSeverity;
  /** `owner/name` of the repository, when the reviewer named one. */
  repository: string | null;
  /** Path relative to the repository. */
  file: string | null;
  line: number | null;
  /** One line. */
  title: string;
  /** What is wrong, why, and what would fix it (Markdown). */
  detail: string;
}

/**
 * Who started a review: the user's button (`manual`), auto-review after a
 * turn (`auto`), or Claude with the tool `request_review` (`claude`).
 */
export type ReviewTrigger = 'manual' | 'auto' | 'claude';

/**
 * When reviews start by themselves in a session (besides the user's
 * button):
 * - `off`: never;
 * - `claude`: when Claude asks with the tool `request_review` (after a
 *   finished work package);
 * - `turn`: after every turn that changed the diff, and when Claude asks.
 */
export type ReviewMode = 'off' | 'claude' | 'turn';

export const REVIEW_MODES: readonly ReviewMode[] = ['off', 'claude', 'turn'];

/** The review mode of new sessions. */
export const DEFAULT_REVIEW_MODE: ReviewMode = 'claude';

/**
 * How a review ended:
 * - `finished`: the reviewer answered (with or without findings);
 * - `failed`: it could not run or gave no usable answer (`error`);
 * - `cancelled`: the user stopped it, or the server stopped.
 */
export type ReviewOutcome = 'finished' | 'failed' | 'cancelled';

/** A review that is running (`SessionReviewDto.running`). */
export interface RunningReviewDto {
  id: string;
  trigger: ReviewTrigger;
  /** The engine it runs with. */
  engine: AgentEngineId;
  /**
   * The engine the settings chose when the server does not have it, so
   * that the review runs with Claude Code instead; `null` otherwise.
   */
  fallbackFrom: AgentEngineId | null;
  /** The model (`null`: the engine's default) and effort it runs with. */
  model: string | null;
  effort: ReviewEffort;
  startedAt: string;
  /** Changed files it was given. */
  fileCount: number;
}

/**
 * Review state and settings of a session (`SessionDto.review`).
 * `engine`, `model` and `effort` `null`: the app's {@link ReviewDefaults}.
 * A model of its own always comes with the engine it belongs to.
 */
export interface SessionReviewDto {
  mode: ReviewMode;
  engine: AgentEngineId | null;
  model: string | null;
  effort: ReviewEffort | null;
  /** The review running now, if any. */
  running: RunningReviewDto | null;
}

/**
 * Body of `PUT /api/sessions/:id/review-settings`; absent fields stay,
 * `null` for `engine`, `model` or `effort` uses the app's default again.
 * A model is one of the engine the session's reviewer has after the
 * request (a model chosen without an engine keeps that engine for the
 * session); changing the engine resets the model unless the request sets
 * one.
 */
export interface UpdateSessionReviewRequest {
  mode?: ReviewMode;
  engine?: AgentEngineId | null;
  model?: string | null;
  effort?: ReviewEffort | null;
}

/**
 * How the app's message to Claude with a review's findings starts (the
 * conversation labels it as the review's).
 */
export const REVIEW_MESSAGE_PREFIX = 'An independent review';

/** Response of `POST /api/sessions/:id/review`: the review started. */
export interface StartReviewResponse {
  review: RunningReviewDto;
}
