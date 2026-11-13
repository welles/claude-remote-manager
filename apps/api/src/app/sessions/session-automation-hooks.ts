import type { GitPushAnalysis } from '@claude-remote-manager/shared-types';

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
}
