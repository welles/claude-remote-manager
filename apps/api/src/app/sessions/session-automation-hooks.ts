import type {
  GitPushAnalysis,
  RunningReviewDto,
} from '@claude-remote-manager/shared-types';

/** Switches of a pull request's automation; `undefined` keeps one. */
export interface PullRequestAutomationSwitches {
  autofix?: boolean;
  automerge?: boolean;
  autoclose?: boolean;
}

/** What the PR automation did with a Bash command instead of a shell. */
export interface AutofixCommandOutcome {
  /** Whether every step succeeded. */
  ok: boolean;
  /** Told to Claude as the command's output (exit status 1 if not `ok`). */
  output: string;
  /** Shown on the tool call in the session's history. */
  summary: string;
}

/**
 * Hooks of the sessions service for the PR automation, which builds on the
 * sessions module (and so cannot be injected into it). Set by the
 * automation at startup; without it sessions behave as before.
 */
export class SessionAutomationHooks {
  /**
   * Called for every Bash command before the user is asked. Returns an
   * outcome when the automation carried the command out itself (during
   * autofix: `git add`, `git commit`, `git push` of the session branch);
   * nobody is asked and no shell runs it. `null` asks the user as usual.
   */
  autofixCommand:
    | ((
        sessionId: string,
        command: string,
        pushes: GitPushAnalysis[],
      ) => Promise<AutofixCommandOutcome | null>)
    | null = null;

  /**
   * The tool `request_owner_decision`: Claude asks for the owner's
   * decision, which pauses automerge of the session's pull requests until
   * the owner's next message. Returns what Claude is told.
   */
  holdAutomerge: ((sessionId: string, question: string) => string) | null =
    null;

  /**
   * Whether Claude's `merge_pull_request` may merge the session's pull
   * request `number` of `repositoryId` without asking: automerge is on for
   * it and it is ready. Returns the head commit checked, `null` if not.
   */
  mayMergeUnasked:
    | ((
        sessionId: string,
        repositoryId: string,
        number: number,
      ) => Promise<string | null>)
    | null = null;

  /**
   * Continues an Autofix run the usage limit stopped, for the pull requests
   * `pullRequestIds` of the session: if autofix is still on for one of them
   * and it is open, `send` sends the continuation as part of the run and
   * the run shows as going on again; returns `false` (without sending)
   * otherwise.
   */
  continueAutofix:
    | ((
        sessionId: string,
        pullRequestIds: number[],
        send: () => Promise<void>,
      ) => Promise<boolean>)
    | null = null;

  /** The owner sent the session a message (not the app). */
  ownerMessage: ((sessionId: string) => void) | null = null;

  /**
   * The independent review running in the session, for `SessionDto.review`
   * (set by the reviews service).
   */
  runningReview: ((sessionId: string) => RunningReviewDto | null) | null = null;

  /**
   * Whether an independent review runs in the session or auto-review is
   * about to start one: the PR automation waits (no run, no merge).
   */
  reviewBusy: ((sessionId: string) => boolean) | null = null;

  /**
   * The tool `request_review`: Claude asks for an independent review of
   * the session's changes. Returns what Claude is told; throws when it is
   * refused (mode off, a review runs, nothing new to review, round limit).
   */
  requestReview: ((sessionId: string) => Promise<string>) | null = null;

  /**
   * The tool `set_pr_automation`: switches autofix, automerge or autoclose
   * of the session's open pull request `number` of `repositoryId`. Returns
   * what Claude is told; throws when it is refused.
   */
  setAutomation:
    | ((
        sessionId: string,
        repositoryId: string,
        number: number,
        switches: PullRequestAutomationSwitches,
      ) => string)
    | null = null;
}
