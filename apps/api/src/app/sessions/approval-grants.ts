/** Name of the app's in-process MCP server for Claude's tools. */
export const APP_MCP_SERVER = 'crm';
export const CREATE_PULL_REQUEST_TOOL = 'create_pull_request';
/** The tool's name as Claude Code reports it to `canUseTool`. */
export const CREATE_PULL_REQUEST_TOOL_NAME = `mcp__${APP_MCP_SERVER}__${CREATE_PULL_REQUEST_TOOL}`;

/** An approved `git push` stays usable at most this long. */
export const PUSH_GRANT_MS = 15 * 60_000;
/** An approved `create_pull_request` call must run within this time. */
export const PULL_REQUEST_GRANT_MS = 5 * 60_000;

/** Commands that run the command after them. */
const COMMAND_WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'time',
  'nice',
  'nohup',
  'sudo',
]);

/** Options of git that take a separate value (`git -C dir push`). */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

/**
 * Whether a shell command runs `git push` in one of its parts. Used to
 * recognize the approval of a push; it errs towards "no" for unusual forms
 * (aliases, scripts that push), which then get a read-only token and fail.
 */
export function isGitPushCommand(command: string): boolean {
  for (const part of command.split(/&&|\|\||[;&|\n()`{}]|\$\(/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    // The command word: after variable assignments and simple wrappers.
    let index = 0;
    while (
      index < words.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) ||
        COMMAND_WRAPPERS.has(words[index]))
    ) {
      index++;
    }
    if (index >= words.length || !/(^|\/)git$/.test(words[index])) {
      continue;
    }
    let next = index + 1;
    while (next < words.length && words[next].startsWith('-')) {
      next += GIT_OPTIONS_WITH_VALUE.has(words[next]) ? 2 : 1;
    }
    if (words[next] === 'push') {
      return true;
    }
  }
  return false;
}

/** The fields of a `create_pull_request` call that the approval covers. */
export function pullRequestCall(input: Record<string, unknown>): string {
  const pick = (name: string) =>
    input[name] === undefined || input[name] === null ? null : input[name];
  return JSON.stringify([
    pick('repository'),
    pick('title'),
    pick('body'),
    pick('base'),
    pick('draft') ?? false,
  ]);
}

interface PushGrant {
  toolUseId: string;
  expiresAt: number;
}

interface SessionGrants {
  pushes: PushGrant[];
  pullRequests: { call: string; expiresAt: number }[];
  /** Write tokens handed out under push grants, revoked when they end. */
  tokens: Set<string>;
}

/**
 * What the user approved in a session, in memory: running `git push`
 * commands (from the approval until Claude Code reports the command's
 * result, at most {@link PUSH_GRANT_MS}) and `create_pull_request` calls
 * (used once). The credential endpoint hands out write tokens only while a
 * push grant is active; the tool refuses calls without a grant. Grants are
 * recorded only by the session's `canUseTool`, so anything that bypasses
 * the approval (a permission mode, an allow rule) gets none.
 */
export class ApprovalGrants {
  private readonly sessions = new Map<string, SessionGrants>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records an approved tool use. */
  approved(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    mcpServer: { name: string; source: string } | null,
  ): void {
    if (
      toolName === 'Bash' &&
      typeof input['command'] === 'string' &&
      isGitPushCommand(input['command'])
    ) {
      this.grants(sessionId).pushes.push({
        toolUseId,
        expiresAt: this.now() + PUSH_GRANT_MS,
      });
    }
    if (
      toolName === CREATE_PULL_REQUEST_TOOL_NAME &&
      (mcpServer === null || mcpServer.source === 'sdk')
    ) {
      this.grants(sessionId).pullRequests.push({
        call: pullRequestCall(input),
        expiresAt: this.now() + PULL_REQUEST_GRANT_MS,
      });
    }
  }

  /** Whether an approved `git push` of the session is running. */
  hasPushGrant(sessionId: string): boolean {
    const grants = this.sessions.get(sessionId);
    return (
      !!grants && grants.pushes.some((grant) => grant.expiresAt > this.now())
    );
  }

  /** Remembers a write token to revoke when the push grants end. */
  addToken(sessionId: string, token: string): void {
    this.grants(sessionId).tokens.add(token);
  }

  /**
   * A tool use finished. Ends its push grant; returns the write tokens to
   * revoke once no push grant is left, and whether a push grant ended.
   */
  toolFinished(
    sessionId: string,
    toolUseId: string,
  ): { pushEnded: boolean; tokens: string[] } {
    const grants = this.sessions.get(sessionId);
    if (!grants) {
      return { pushEnded: false, tokens: [] };
    }
    const before = grants.pushes.length;
    grants.pushes = grants.pushes.filter(
      (grant) => grant.toolUseId !== toolUseId && grant.expiresAt > this.now(),
    );
    const pushEnded = grants.pushes.length < before;
    let tokens: string[] = [];
    if (grants.pushes.length === 0 && grants.tokens.size > 0) {
      tokens = [...grants.tokens];
      grants.tokens.clear();
    }
    return { pushEnded, tokens };
  }

  /** Uses up the approval of a `create_pull_request` call with this input. */
  consumePullRequestGrant(
    sessionId: string,
    input: Record<string, unknown>,
  ): boolean {
    const grants = this.sessions.get(sessionId);
    if (!grants) {
      return false;
    }
    const call = pullRequestCall(input);
    grants.pullRequests = grants.pullRequests.filter(
      (grant) => grant.expiresAt > this.now(),
    );
    const index = grants.pullRequests.findIndex((grant) => grant.call === call);
    if (index < 0) {
      return false;
    }
    grants.pullRequests.splice(index, 1);
    return true;
  }

  /** Forgets the session's grants; returns write tokens to revoke. */
  clear(sessionId: string): string[] {
    const grants = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return grants ? [...grants.tokens] : [];
  }

  private grants(sessionId: string): SessionGrants {
    let grants = this.sessions.get(sessionId);
    if (!grants) {
      grants = { pushes: [], pullRequests: [], tokens: new Set() };
      this.sessions.set(sessionId, grants);
    }
    return grants;
  }
}
