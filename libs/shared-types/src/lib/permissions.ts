import type { SessionPermissionMode } from './session';

/**
 * Approval requests: what Claude wants to do when a tool use needs the
 * user's decision, and how the user answers. The requests and their
 * resolutions travel as `permission.request` / `permission.resolved`
 * session events (see `session-events.ts`).
 */

/** One destination of a `git push` command. */
export interface GitPushTarget {
  /** Destination ref as written (`main`, `refs/heads/x`, `HEAD`, ...). */
  destination: string;
  /** Short branch name if the destination is a branch (`HEAD`: current). */
  branch: string | null;
  /** Forced by a leading `+` in the refspec. */
  forced: boolean;
  /** `:dst`: deletes the destination. */
  deletes: boolean;
}

/**
 * What a `git push` in a Bash command would update. The approval of a push
 * lets the credential helper hand out a write token for the whole
 * repository, so the dialog warns when it is more than the session branch.
 */
export interface GitPushAnalysis {
  /** The `git push` part of the command, as written. */
  command: string;
  remote: string | null;
  targets: GitPushTarget[];
  /** `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, `+` refspecs. */
  force: boolean;
  /** `--delete`, `-d`, `:dst` refspecs, `--prune`. */
  deletes: boolean;
  /** `--all`, `--branches`, `--mirror` or `--tags`: more than named refs. */
  everything: boolean;
  /**
   * Only the session branch (by name, or `HEAD`/no refspec, which push the
   * current branch: normally the session branch), without force or
   * delete. `false` when anything else is pushed or it is unclear.
   */
  sessionBranchOnly: boolean;
  /** Plain-language warnings for the dialog; empty for a plain push. */
  warnings: string[];
}

/**
 * What an approval request is about:
 * - `tool`: a tool use (command, file change, fetch, ...): allow or deny;
 * - `question`: Claude asks the user (`AskUserQuestion`): answers;
 * - `plan`: Claude presents its plan to leave plan mode (`ExitPlanMode`):
 *   approve (and choose the mode to continue in) or keep planning.
 */
export type PermissionRequestKind = 'tool' | 'question' | 'plan';

export interface UserQuestionOption {
  label: string;
  description: string;
  /** Preview content Claude may add (Markdown), `null` without. */
  preview: string | null;
}

/** A question of `AskUserQuestion`; the user may also answer in own words. */
export interface UserQuestion {
  /** Full question; also the key of its answer. */
  question: string;
  /** Short label (chip). */
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

/** A `create_pull_request` call, with the defaults the tool would use. */
export interface PullRequestCall {
  /** `owner/name`; filled in when Claude omitted it and it is unambiguous. */
  repository: string | null;
  title: string;
  body: string | null;
  /** Base branch; filled in with the session clone's base when omitted. */
  base: string | null;
  draft: boolean;
}

/**
 * What "Allow for this session" would allow from now on, in addition to
 * this request: permission rules (e.g. `Bash(npm test:*)`), directories
 * and/or a permission mode. Kept until the session ends (also across
 * restarts of its Claude Code process); never written to settings files.
 */
export interface SessionAllowOffer {
  rules: string[];
  directories: string[];
  mode: SessionPermissionMode | null;
}

/**
 * Why a request was resolved: the user answered, or it was cancelled
 * because the turn was interrupted, the session ended, its Claude Code
 * process exited or the server restarted (the tool was not used then).
 */
export type PermissionResolutionCause =
  | 'user'
  | 'interrupted'
  | 'ended'
  | 'process_exit'
  | 'restart';

/** Modes a plan can be approved into. */
export type PlanApprovalMode = 'default' | 'acceptEdits';

/**
 * The user's answer to a request (body of
 * `POST /api/sessions/:id/permission-requests/:requestId`, and the fields of
 * the `permission.respond` frame).
 *
 * - `tool`: `allow` (with `scope: 'session'` only when the request offered
 *   it) or `deny` with an optional message to Claude. A denial without
 *   message stops the turn; with a message Claude continues with it.
 * - `question`: `allow` with `answers` (question text to answer: an
 *   option's label, labels joined with `, ` for multi-select, or own text),
 *   or `deny` (no answer) with an optional message.
 * - `plan`: `allow` with `mode` to continue in (default `default`), or
 *   `deny` to keep planning, with optional feedback.
 */
export interface PermissionResponse {
  decision: 'allow' | 'deny';
  scope?: 'once' | 'session';
  message?: string;
  answers?: Record<string, string>;
  mode?: PlanApprovalMode;
}

/** Labels and explanations of the permission modes offered in the UI. */
export const PERMISSION_MODE_INFO: Record<
  SessionPermissionMode,
  { label: string; description: string }
> = {
  default: {
    label: 'Ask',
    description:
      'Claude asks before commands, file changes and other actions that need approval.',
  },
  acceptEdits: {
    label: 'Accept edits',
    description:
      "File changes and file commands (mkdir, mv, rm, …) in the session's directories run without asking; other commands still ask.",
  },
  plan: {
    label: 'Plan',
    description:
      'Claude only reads and plans, then presents the plan for approval before changing anything.',
  },
  dontAsk: {
    label: "Don't ask",
    description:
      'Nothing that needs approval runs: such actions are denied instead of asking (for unattended work).',
  },
};

/** A model to choose for a session. */
export interface ModelOption {
  /** Model name or alias to request; `null`: Claude Code's default. */
  value: string | null;
  label: string;
  description: string;
  /** Model ID the value currently resolves to, when known. */
  resolvedModel: string | null;
}

/** Response of `GET /api/models`. */
export interface ModelListResponse {
  models: ModelOption[];
  /**
   * `claude-code`: the list Claude Code reported for the logged-in
   * account; `fallback`: a fixed list because Claude Code could not be asked.
   */
  source: 'claude-code' | 'fallback';
  /** When the list was read from Claude Code (ISO 8601). */
  updatedAt: string | null;
}

/**
 * Body of `PATCH /api/sessions/:id` (and the `session.update` frame): change
 * the model or permission mode, also while the session runs (applied to
 * its Claude Code process right away).
 */
export interface UpdateSessionRequest {
  /** Model name or alias; `null` for Claude Code's default. */
  model?: string | null;
  permissionMode?: SessionPermissionMode;
}
