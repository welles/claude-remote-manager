import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { MAX_PREVIEW_NAME_LENGTH } from '@claude-remote-manager/shared-types';
import type { AgentTool } from '../agent/agent-runner';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { handOverToSession } from '../common/ownership';
import { credentialHelperCommand } from '../git/credential-helper';
import { GitService } from '../git/git.service';
import { InstallationTokens } from '../github/installation-tokens';
import { FileAccessError } from '../files/session-file-access';
import { ShownFilesService } from '../shown-files/shown-files.service';
import { PreviewsService } from '../previews/previews.service';
import {
  ApprovalGrants,
  CREATE_PULL_REQUEST_TOOL,
  EXPOSE_PORT_TOOL,
  EXPOSE_PORT_TOOL_NAME,
  SHOW_FILE_TOOL,
  SHOW_FILE_TOOL_NAME,
  STOP_PREVIEW_TOOL,
  STOP_PREVIEW_TOOL_NAME,
} from './approval-grants';
import { SessionCredentials } from './session-credentials';
import { SessionGitService } from './session-git.service';
import type { SessionRecord } from './session.repository';

/** What a Claude Code process of a session gets besides its directories. */
export interface LaunchExtras {
  env: Record<string, string>;
  tools: AgentTool[];
  settings?: Record<string, unknown>;
  /** Permission rules that allow tools without asking. */
  allowedTools?: string[];
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
 *   cancels them itself when the turn, session or process ends);
 * - the Claude account's claude.ai connectors are not fetched (sessions get
 *   no MCP servers but the app's own, see `STRICT_MCP_CONFIG`).
 */
export const SESSION_PERMISSION_SETTINGS = {
  permissions: {
    ask: ['Bash(git push:*)'],
    disableBypassPermissionsMode: 'disable',
    disableAutoMode: 'disable',
  },
  useAutoModeDuringPlan: false,
  dialogExpiry: 'never',
  disableClaudeAiConnectors: true,
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
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
    }
  }
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
    private readonly shownFiles: ShownFilesService,
    @Optional()
    private readonly previews?: PreviewsService,
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
    const previews = this.previews?.enabled ? this.previews : null;
    return {
      env: {
        CRM_API_URL: this.config.internalApiUrl,
        CRM_SESSION_TOKEN: this.sessionCredentials.issue(record.id),
      },
      tools: [
        this.showFileTool(record.id),
        ...(githubClones.length > 0
          ? [this.createPullRequestTool(record.id)]
          : []),
        ...(previews
          ? [
              this.exposePortTool(record.id, previews),
              this.stopPreviewTool(record.id, previews),
            ]
          : []),
      ],
      settings,
      // Showing a file reads only inside the session's directories;
      // previews forward only the session user's own ports.
      allowedTools: [
        SHOW_FILE_TOOL_NAME,
        ...(previews ? [EXPOSE_PORT_TOOL_NAME, STOP_PREVIEW_TOOL_NAME] : []),
      ],
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

  /**
   * The tool `show_file` of a session: puts a file of the session's
   * directories in front of the user (a card in the conversation, opened
   * in a viewer), as it is now. No approval: it cannot write, and it reads
   * only inside the session's directories, as the session user.
   */
  showFileTool(sessionId: string): AgentTool {
    return {
      name: SHOW_FILE_TOOL,
      description:
        'Show a file to the user: it appears as a card in the conversation and opens in a viewer ' +
        '(images directly, Markdown and HTML rendered, code and text highlighted, PDF embedded, ' +
        'anything else as a download), with the content it has now. Use it when you want the user ' +
        'to look at a file you produced or found for them, such as a screenshot, an image, a ' +
        'report, an HTML page or a PDF. Do not use it for every file you read or change: the ' +
        "user sees your file changes as diffs anyway. Only files inside this session's " +
        'directories (working directory and additional directories).',
      alwaysAsk: false,
      readOnly: true,
      inputSchema: (z) => ({
        path: z
          .string()
          .min(1)
          .max(4096)
          .describe(
            'Path of the file, absolute or relative to the working directory',
          ),
        caption: z
          .string()
          .max(500)
          .optional()
          .describe('Optional short caption shown with the file'),
      }),
      handler: async (input, { toolUseId }) => {
        try {
          const file = await this.shownFiles.show(
            sessionId,
            toolUseId,
            String(input['path']),
            typeof input['caption'] === 'string' ? input['caption'] : null,
            'show_file',
          );
          return {
            text: file.snapshot
              ? `Shown to the user: ${file.path} (${file.kind}, ${file.size} bytes).`
              : `Shown to the user: ${file.path} (${file.kind}, ${file.size} bytes). It is too large to keep a copy, so the user sees it only while the file exists.`,
          };
        } catch (error) {
          return {
            isError: true,
            text:
              error instanceof FileAccessError
                ? `The file was not shown: ${error.message}`
                : `The file was not shown: ${errorText(error)}`,
          };
        }
      },
    };
  }

  /**
   * The tool `expose_port` of a session: forwards a preview host name to a
   * port of the session's dev server. No approval (the owner's decision):
   * only the session user's own ports on loopback can be forwarded, and
   * the user sees every preview and can stop it.
   */
  exposePortTool(sessionId: string, previews: PreviewsService): AgentTool {
    return {
      name: EXPOSE_PORT_TOOL,
      description:
        'Make a dev server of this session reachable for the user as a preview: the session ' +
        'manager forwards a host name of its own to the port (HTTP and WebSockets, so hot ' +
        'reload works) and shows the user a card with the link, to open it in the browser or ' +
        'embedded. Start the server first, in the background, listening on 127.0.0.1, ' +
        'localhost or 0.0.0.0. The dev server sees requests as if the browser opened ' +
        'http://localhost:<port> (Host and Origin), so no allowed-hosts configuration is ' +
        'needed. Returns the preview URL. Exposing a port again only renames the preview. ' +
        'Use stop_preview when it is no longer needed; the user can stop it as well.',
      alwaysAsk: false,
      inputSchema: (z) => ({
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe('TCP port the dev server listens on'),
        name: z
          .string()
          .min(1)
          .max(MAX_PREVIEW_NAME_LENGTH)
          .describe('Short name for the user, e.g. "Web app" or "Storybook"'),
      }),
      handler: async (input, { toolUseId }) => {
        try {
          const { preview, created } = previews.expose(
            sessionId,
            Number(input['port']),
            String(input['name']),
            toolUseId,
          );
          const waiting =
            preview.state === 'running'
              ? ''
              : ` Nothing listens on port ${preview.port} yet; the preview shows a waiting page until the server is up.`;
          return {
            text: `${created ? 'Exposed' : 'Already exposed'}: "${preview.name}" (port ${preview.port}) at ${preview.url}. The user sees a card with this link.${waiting} You cannot open this URL yourself; test the server on http://localhost:${preview.port}.`,
          };
        } catch (error) {
          return {
            isError: true,
            text: `The port was not exposed: ${errorText(error)}`,
          };
        }
      },
    };
  }

  /** The tool `stop_preview` of a session: ends a preview's forwarding. */
  stopPreviewTool(sessionId: string, previews: PreviewsService): AgentTool {
    return {
      name: STOP_PREVIEW_TOOL,
      description:
        'Stop the preview of a port that expose_port made: its host name stops forwarding. ' +
        'The dev server itself keeps running until you stop it.',
      alwaysAsk: false,
      inputSchema: (z) => ({
        port: z.number().int().min(1).max(65535).describe('The exposed port'),
      }),
      handler: async (input, { toolUseId }) => {
        try {
          const preview = previews.stopPort(
            sessionId,
            Number(input['port']),
            toolUseId,
          );
          return {
            text: `Stopped the preview "${preview.name}" of port ${preview.port}.`,
          };
        } catch (error) {
          return {
            isError: true,
            text: `No preview was stopped: ${errorText(error)}`,
          };
        }
      },
    };
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
