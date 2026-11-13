import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AgentTool } from '../agent/agent-runner';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { handOverToSession } from '../common/ownership';
import { credentialHelperCommand } from '../git/credential-helper';
import { GitService } from '../git/git.service';
import { InstallationTokens } from '../github/installation-tokens';
import { ApprovalGrants, CREATE_PULL_REQUEST_TOOL } from './approval-grants';
import { SessionCredentials } from './session-credentials';
import { SessionGitService } from './session-git.service';
import type { SessionRecord } from './session.repository';

/** What a Claude Code process of a session gets besides its directories. */
export interface LaunchExtras {
  env: Record<string, string>;
  tools: AgentTool[];
  settings?: Record<string, unknown>;
}

/**
 * Permission settings every session gets on top of the user's and
 * project's settings:
 * - `git push` always asks (an ask rule wins over allow rules, e.g. from a
 *   repository's `.claude/settings.json`), so the user's approval is what
 *   lets a push through (see {@link ApprovalGrants});
 * - no bypass mode, and no auto mode: approvals come from the user, not
 *   from a classifier (also not during plan mode);
 * - approval requests do not expire while the user is away (the app
 *   cancels them itself when the turn, session or process ends).
 */
export const SESSION_PERMISSION_SETTINGS = {
  permissions: {
    ask: ['Bash(git push:*)'],
    disableBypassPermissionsMode: 'disable',
    disableAutoMode: 'disable',
  },
  useAutoModeDuringPlan: false,
  dialogExpiry: 'never',
};

/** Hooks of the sessions service for the app's integrations. */
export abstract class SessionAgentSupport {
  /** Environment, tools and settings for a process about to start. */
  abstract prepare(record: SessionRecord): Promise<LaunchExtras>;
  /** The user approved a tool use (through `canUseTool`). */
  abstract approved(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    mcpServer: { name: string; source: string } | null,
  ): void;
  /** Claude Code reported the result of a tool use. */
  abstract toolFinished(sessionId: string, toolUseId: string): void;
  /** The session's process ended. */
  abstract released(sessionId: string): void;
}

/** Without integrations (tests of the session lifecycle). */
export class NoSessionAgentSupport extends SessionAgentSupport {
  async prepare(): Promise<LaunchExtras> {
    return { env: {}, tools: [] };
  }
  approved(): void {
    // nothing
  }
  toolFinished(): void {
    // nothing
  }
  released(): void {
    // nothing
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session's integrations with git and GitHub:
 * - a process token and the API URL in the environment, for the git
 *   credential helper configured in every GitHub clone;
 * - the tool `create_pull_request` (runs only for approved calls);
 * - auto-memory per repository: Claude Code keeps its memory per working
 *   directory, i.e. per session clone; all sessions of a repository share
 *   `<memoryDir>/<repository id>` instead (scratch sessions keep Claude
 *   Code's default);
 * - grants for approved pushes, ended (and their write tokens revoked)
 *   when the command finished or the process ended.
 */
@Injectable()
export class SessionAgentSupportService extends SessionAgentSupport {
  private readonly logger = new Logger(SessionAgentSupportService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessionCredentials: SessionCredentials,
    private readonly grants: ApprovalGrants,
    private readonly sessionGit: SessionGitService,
    private readonly git: GitService,
    private readonly tokens: InstallationTokens,
  ) {
    super();
  }

  async prepare(record: SessionRecord): Promise<LaunchExtras> {
    const githubClones = record.directories.filter(
      (directory) =>
        directory.kind === 'clone' &&
        directory.state === 'ready' &&
        directory.repositoryGitHub,
    );
    // Clones made before, or by another build (paths of node and the
    // helper), get the current helper.
    for (const directory of githubClones) {
      try {
        await this.git.setCredentialHelper(
          directory.path,
          credentialHelperCommand(),
        );
      } catch (error) {
        this.logger.warn(
          `Could not configure the credential helper in ${directory.path}: ${errorText(error)}`,
        );
      }
    }
    const settings: Record<string, unknown> = {
      ...SESSION_PERMISSION_SETTINGS,
    };
    const main = record.directories[0];
    if (main?.kind === 'clone' && main.repositoryId) {
      const memory = join(this.config.memoryDir, main.repositoryId);
      await mkdir(memory, { recursive: true });
      // Claude Code writes the memory as the session user.
      await handOverToSession(memory, this.git.launcher);
      settings['autoMemoryDirectory'] = memory;
    }
    return {
      env: {
        CRM_API_URL: this.config.internalApiUrl,
        CRM_SESSION_TOKEN: this.sessionCredentials.issue(record.id),
      },
      tools:
        githubClones.length > 0 ? [this.createPullRequestTool(record.id)] : [],
      settings,
    };
  }

  approved(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    mcpServer: { name: string; source: string } | null,
  ): void {
    this.grants.approved(sessionId, toolName, input, toolUseId, mcpServer);
  }

  toolFinished(sessionId: string, toolUseId: string): void {
    const { pushEnded, tokens } = this.grants.toolFinished(
      sessionId,
      toolUseId,
    );
    this.revoke(tokens);
    if (pushEnded) {
      void this.notePushes(sessionId);
    }
  }

  released(sessionId: string): void {
    this.sessionCredentials.revoke(sessionId);
    this.revoke(this.grants.clear(sessionId));
  }

  /** The tool `create_pull_request` of a session. */
  createPullRequestTool(sessionId: string): AgentTool {
    return {
      name: CREATE_PULL_REQUEST_TOOL,
      description:
        'Create a GitHub pull request from the session branch of one of this ' +
        "session's repositories. Push the branch first (git push); the user " +
        'approves each call. Returns the URL of the pull request (or of the open ' +
        'one that exists for the branch already).',
      alwaysAsk: true,
      inputSchema: (z) => ({
        repository: z
          .string()
          .max(200)
          .optional()
          .describe(
            'owner/name of the repository; may be omitted if the session has only one GitHub repository',
          ),
        title: z.string().min(1).max(256).describe('Title of the pull request'),
        body: z
          .string()
          .max(65_536)
          .optional()
          .describe('Description in Markdown'),
        base: z
          .string()
          .max(200)
          .optional()
          .describe(
            'Branch to merge into; default: the branch the session started from',
          ),
        draft: z.boolean().optional().describe('Open as draft'),
      }),
      handler: async (input) => {
        if (!this.grants.consumePullRequestGrant(sessionId, input)) {
          return {
            isError: true,
            text: 'This create_pull_request call was not approved by the user in this session, so no pull request was created.',
          };
        }
        const repositoryId = this.repositoryOf(
          sessionId,
          typeof input['repository'] === 'string' ? input['repository'] : null,
        );
        const pull = await this.sessionGit.createPullRequest(
          sessionId,
          repositoryId,
          {
            title: input['title'] as string,
            body: input['body'] as string | undefined,
            base: input['base'] as string | undefined,
            draft: input['draft'] as boolean | undefined,
          },
          'claude',
        );
        return {
          text: `Pull request #${pull.number} (${pull.state}) of ${pull.repository}: ${pull.url}`,
        };
      },
    };
  }

  // -------------------------------------------------------------------------

  /** The GitHub repository of a session that a tool call names. */
  private repositoryOf(sessionId: string, name: string | null): string {
    const record = this.sessionGit.sessionRecord(sessionId);
    const candidates = record.directories.filter(
      (directory) =>
        directory.kind === 'clone' &&
        directory.repositoryGitHub &&
        directory.repositoryId,
    );
    const matches = name
      ? candidates.filter(
          (directory) =>
            directory.repositoryName?.toLowerCase() === name.toLowerCase(),
        )
      : candidates;
    if (matches.length !== 1) {
      const names = candidates
        .map((directory) => directory.repositoryName)
        .join(', ');
      throw new Error(
        name
          ? `${name} is not a GitHub repository of this session (${names || 'none'})`
          : `Name the repository: this session has ${names || 'no GitHub repositories'}`,
      );
    }
    return matches[0].repositoryId as string;
  }

  /** After an approved push: note what reached the remote. */
  private async notePushes(sessionId: string): Promise<void> {
    try {
      const record = this.sessionGit.sessionRecord(sessionId);
      for (const directory of record.directories) {
        if (directory.kind === 'clone' && directory.repositoryId) {
          await this.sessionGit.notePushedCommit(
            sessionId,
            directory.repositoryId,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not check the pushes of ${sessionId}: ${errorText(error)}`,
      );
    }
  }

  private revoke(tokens: string[]): void {
    for (const token of tokens) {
      this.tokens
        .revoke(token)
        .catch((error: unknown) =>
          this.logger.warn(`Could not revoke a token: ${errorText(error)}`),
        );
    }
  }
}
