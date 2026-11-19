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

  /**
   * The tool `request_owner_decision`: Claude asks for the owner's
   * decision, which pauses automerge of the session's pull requests until
   * the owner's next message. Returns what Claude is told.
   */
  holdAutomerge: ((sessionId: string, question: string) => string) | null =
    null;

  /** The owner sent the session a message (not the app). */
  ownerMessage: ((sessionId: string) => void) | null = null;
}
