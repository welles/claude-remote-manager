import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Subject } from 'rxjs';
import {
  isRetiredClone,
  MAX_LISTED_COMMITS,
  type CommitSummary,
  type CommitsAddedEvent,
  type SessionEvent,
  type SessionEventInput,
} from '@claude-remote-manager/shared-types';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
} from '../common/process-isolation';
import { runGit } from '../git/git-runner';
import { KeyedMutex } from '../git/keyed-mutex';
import {
  SessionRepository,
  type SessionDirectoryRecord,
} from '../sessions/session.repository';
import { COMMIT_ID, listCommits, type CloneGit } from './commit-log';

const GIT_TIMEOUT_MS = 30_000;

/**
 * Tools that never move a branch: their results are no reason to look.
 * Everything else (`Bash`, a background command's output, MCP tools, ...)
 * is.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'ToolSearch',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'mcp__crm__set_session_title',
  'mcp__crm__set_waiting_state',
  'mcp__crm__show_file',
]);

type CommitsAddedInput = Omit<CommitsAddedEvent, 'seq' | 'at'>;

/**
 * Finds the commits a session adds to its branches, for the history: after
 * each tool call that may have moved a branch and at the end of each turn,
 * it compares the session branch of every clone with the commit it saw
 * last (`observed_head`) and reports what is new as `commits.added`:
 * commits reachable from the branch but neither from that commit nor from
 * the base branch as the clone knows it (`origin/<base branch>`), so
 * commits a rebase or merge brings in from there do not count, and a
 * rebase shows the commits it rewrote.
 *
 * git runs in the clone as the session user (its content and configuration
 * are the session's). Looks run one at a time per session.
 */
@Injectable()
export class SessionCommitsService {
  private readonly logger = new Logger(SessionCommitsService.name);
  private readonly mutex = new KeyedMutex();
  /** Names of running tool calls, by session and tool use. */
  private readonly toolNames = new Map<string, Map<string, string>>();
  private readonly added = new Subject<{
    sessionId: string;
    event: CommitsAddedInput;
  }>();

  /** New commits, to be added to the session's history. */
  readonly added$ = this.added.asObservable();

  constructor(
    private readonly sessions: SessionRepository,
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    private readonly launcher: ProcessLauncher = SINGLE_USER,
  ) {}

  /** Looks for new commits when a live event of a session calls for it. */
  observe(sessionId: string, event: SessionEvent | SessionEventInput): void {
    switch (event.type) {
      case 'tool.call': {
        let names = this.toolNames.get(sessionId);
        if (!names) {
          names = new Map();
          this.toolNames.set(sessionId, names);
        }
        names.set(event.toolUseId, event.name);
        return;
      }
      case 'tool.result': {
        const names = this.toolNames.get(sessionId);
        const name = names?.get(event.toolUseId);
        names?.delete(event.toolUseId);
        if (name === undefined || !READ_ONLY_TOOLS.has(name)) {
          void this.check(sessionId, event.toolUseId);
        }
        return;
      }
      case 'tool.by_app':
        // The app committed itself (autofix).
        void this.check(sessionId, event.toolUseId);
        return;
      case 'turn.result':
        this.toolNames.delete(sessionId);
        void this.check(sessionId, null);
        return;
      default:
        return;
    }
  }

  /**
   * Compares the session branches with the commits seen last and reports
   * new commits, attributed to the tool use `toolUseId` (`null`: none).
   * Never fails.
   */
  check(sessionId: string, toolUseId: string | null): Promise<void> {
    return this.mutex.run(sessionId, async () => {
      try {
        const record = this.sessions.get(sessionId);
        if (!record) {
          return;
        }
        const observed = this.sessions.observedHeads(sessionId);
        for (const directory of record.directories) {
          if (!watched(directory)) {
            continue;
          }
          try {
            const event = await this.checkDirectory(
              sessionId,
              directory,
              observed.get(directory.position) ?? null,
              toolUseId,
            );
            if (event) {
              this.added.next({ sessionId, event });
            }
          } catch (error) {
            this.logger.warn(
              `Could not look for new commits in ${directory.path}: ${String(error)}`,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Could not look for new commits of ${sessionId}: ${String(error)}`,
        );
      }
    });
  }

  private async checkDirectory(
    sessionId: string,
    directory: SessionDirectoryRecord & { branch: string },
    observed: string | null,
    toolUseId: string | null,
  ): Promise<CommitsAddedInput | null> {
    const git: CloneGit = (args) =>
      runGit(args, {
        cwd: directory.path,
        launcher: this.launcher,
        as: 'session',
        timeoutMs: GIT_TIMEOUT_MS,
      });
    const head = await verify(git, `refs/heads/${directory.branch}`);
    if (!head || head === observed) {
      return null;
    }
    const candidate = observed ?? directory.baseCommit;
    const previous =
      candidate && COMMIT_ID.test(candidate)
        ? await verify(git, candidate)
        : null;
    if (observed !== null && previous === null) {
      // A directory from before the app looked (`''`), or the commit seen
      // last is gone: what is new cannot be told, only note where it is.
      this.sessions.setObservedHead(sessionId, directory.position, head);
      return null;
    }
    const base = directory.baseBranch
      ? await verify(git, `refs/remotes/origin/${directory.baseBranch}`)
      : null;
    const exclude = [previous, base].filter(
      (commit): commit is string => commit !== null,
    );
    const { commits, count } = await this.list(git, head, exclude);
    const rewritten =
      previous !== null && !(await isAncestor(git, previous, head));
    // Noted only once listed: a look that fails is repeated next time.
    this.sessions.setObservedHead(sessionId, directory.position, head);
    if (count === 0) {
      return null;
    }
    return {
      type: 'commits.added',
      toolUseId,
      repositoryId: directory.repositoryId,
      repository: directory.repositoryName ?? directory.path,
      branch: directory.branch,
      previousHead: previous,
      head,
      rewritten,
      commits,
      commitCount: count,
    };
  }

  /**
   * The new commits; when git cannot list them with their file stats (too
   * large: timeout, output limit), without, so the same range is not tried
   * again and again.
   */
  private async list(
    git: CloneGit,
    head: string,
    exclude: string[],
  ): Promise<{ commits: CommitSummary[]; count: number }> {
    try {
      return await listCommits(git, head, exclude, MAX_LISTED_COMMITS);
    } catch (error) {
      this.logger.warn(
        `Listing new commits with their files failed, listing them without: ${String(error)}`,
      );
      return listCommits(git, head, exclude, MAX_LISTED_COMMITS, {
        stats: false,
      });
    }
  }
}

/** The session branches the app looks at: of clones Claude works in. */
function watched(
  directory: SessionDirectoryRecord,
): directory is SessionDirectoryRecord & { branch: string } {
  return (
    directory.kind === 'clone' &&
    directory.branch !== null &&
    directory.state === 'ready' &&
    !isRetiredClone(directory) &&
    (directory.addition === null || directory.addition.state === 'ready')
  );
}

/** The commit a ref or commit ID names, `null` if none. */
async function verify(git: CloneGit, rev: string): Promise<string | null> {
  const commit = (
    await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).catch(
      () => '',
    )
  ).trim();
  return COMMIT_ID.test(commit) ? commit : null;
}

async function isAncestor(
  git: CloneGit,
  ancestor: string,
  commit: string,
): Promise<boolean> {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}
