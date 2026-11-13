import type { GitPushAnalysis } from '@claude-remote-manager/shared-types';

/** What the PR automation did with a `git push` instead of asking. */
export interface AutoPushOutcome {
  /** Told to Claude as the tool's result (the command itself is not run). */
  message: string;
  /** Shown in the session's history. */
  notice: string;
}

/**
 * Hooks of the sessions service for the PR automation, which builds on the
 * sessions module (and so cannot be injected into it). Set by the
 * automation at startup; without it sessions behave as before.
 */
export class SessionAutomationHooks {
  /**
   * Called for a Bash command with `git push` before the user is asked.
   * Returns an outcome when the automation pushed itself (the command is
   * then not run and nobody is asked), `null` to ask the user as usual.
   */
  autoPush:
    | ((
        sessionId: string,
        command: string,
        pushes: GitPushAnalysis[],
      ) => Promise<AutoPushOutcome | null>)
    | null = null;
}
