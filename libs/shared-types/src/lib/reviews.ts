/*
 * Independent reviews of a session's changes: the app runs a reviewer of
 * its own (a separate, read-only Claude Code process with a model and
 * effort of its own) on the session diff and gives its findings to the
 * session's Claude to fix.
 */

/** Reasoning effort of the reviewer (Claude Code's effort levels). */
export type ReviewEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REVIEW_EFFORTS: readonly ReviewEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** The reviewer's model unless the settings say otherwise. */
export const DEFAULT_REVIEW_MODEL = 'claude-fable-5-2';
export const DEFAULT_REVIEW_EFFORT: ReviewEffort = 'high';
/** Auto-review rounds with findings in a row before auto-review stops. */
export const DEFAULT_AUTO_REVIEW_ROUNDS = 3;
export const MAX_AUTO_REVIEW_ROUNDS = 20;

/**
 * The app's review settings (`GET`/`PUT /api/settings/review`), for every
 * session that does not choose its own model or effort.
 */
export interface ReviewDefaults {
  /** Model name or alias. */
  model: string;
  effort: ReviewEffort;
  /**
   * Auto-review rounds with findings in a row, after which auto-review
   * waits for the user's next message (1 to {@link MAX_AUTO_REVIEW_ROUNDS}).
   */
  maxAutoRounds: number;
}

/** Body of `PUT /api/settings/review`; absent fields stay. */
export type UpdateReviewDefaultsRequest = Partial<ReviewDefaults>;

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
  /** The model and effort it runs with. */
  model: string;
  effort: ReviewEffort;
  startedAt: string;
  /** Changed files it was given. */
  fileCount: number;
}

/**
 * Review state and settings of a session (`SessionDto.review`).
 * `model` and `effort` `null`: the app's {@link ReviewDefaults}.
 */
export interface SessionReviewDto {
  mode: ReviewMode;
  model: string | null;
  effort: ReviewEffort | null;
  /**
   * Rounds with findings in a row of reviews that started by themselves
   * (auto-review and Claude's requests) since the user's last message (or
   * the last review without findings).
   */
  autoRounds: number;
  /** The review running now, if any. */
  running: RunningReviewDto | null;
}

/**
 * Body of `PUT /api/sessions/:id/review-settings`; absent fields stay,
 * `null` for `model` or `effort` uses the app's default again.
 */
export interface UpdateSessionReviewRequest {
  mode?: ReviewMode;
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
