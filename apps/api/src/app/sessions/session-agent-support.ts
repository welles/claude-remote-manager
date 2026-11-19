import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
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
import { GitService } from '../git/git.service';
import { FileAccessError } from '../files/session-file-access';
import { ShownFilesService } from '../shown-files/shown-files.service';
import { PreviewsService } from '../previews/previews.service';
import {
  CREATE_PULL_REQUEST_TOOL,
  EXPOSE_PORT_TOOL,
  EXPOSE_PORT_TOOL_NAME,
  REQUEST_OWNER_DECISION_TOOL,
  REQUEST_OWNER_DECISION_TOOL_NAME,
  SHOW_FILE_TOOL,
  SHOW_FILE_TOOL_NAME,
  STOP_PREVIEW_TOOL,
  STOP_PREVIEW_TOOL_NAME,
  isGitPushCommand,
} from './app-tools';
import { SessionAutomationHooks } from './session-automation-hooks';
import { SessionGitService } from './session-git.service';
import { SessionGitHubTokensService } from './session-github-tokens.service';
import type { SessionRecord } from './session.repository';

/** What a Claude Code process of a session gets besides its directories. */
export interface LaunchExtras {
  env: Record<string, string>;
  tools: AgentTool[];
  settings?: Record<string, unknown>;
  /** Permission rules that allow tools without asking. */
  allowedTools?: string[];
  /** Appended to the system prompt, see `AgentStartOptions.instructions`. */
  instructions?: string;
}

/**
 * Settings every session gets on top of the user's, project's and local
 * settings (which apply as in a terminal):
 * - auto mode only when the session chose it, not during plan mode (plan
 *   mode keeps asking the user);
 * - approval requests do not expire while the user is away (the app
 *   cancels them itself when the turn, session or process ends).
 */
export const SESSION_SETTINGS = {
  useAutoModeDuringPlan: false,
  dialogExpiry: 'never',
};

/** Hooks of the sessions service for the app's integrations. */
export abstract class SessionAgentSupport {
  /** Environment, tools and settings for a process about to start. */
  abstract prepare(record: SessionRecord): Promise<LaunchExtras>;
  /** Claude Code called a tool (whether or not it asked the user). */
  abstract toolCalled(
    sessionId: string,
    toolName: string,
    input: unknown,
    toolUseId: string,
  ): void;
  /** Claude Code reported the result of a tool use. */
  abstract toolFinished(sessionId: string, toolUseId: string): void;
  /** The session's process ended. */
  abstract released(sessionId: string): void;
  /**
   * Removes the credential helper earlier versions put into session clones
   * (it hid the user's own credentials), once at startup for all sessions,
   * so also a push from a terminal in an old clone works.
   */
  cleanUpClones(records: SessionRecord[]): Promise<void> {
    void records;
    return Promise.resolve();
  }
}

/** Without integrations (tests of the session lifecycle). */
export class NoSessionAgentSupport extends SessionAgentSupport {
  async prepare(): Promise<LaunchExtras> {
    return { env: {}, tools: [] };
  }
  toolCalled(): void {
    // nothing
  }
  toolFinished(): void {
    // nothing
  }
  released(): void {
    // nothing
  }
}

export const GITHUB_HELPER_SCRIPT = 'crm-github.cjs';

/**
 * Command line of the GitHub token helper: this Node.js and the script
 * next to the API bundle in `assets/` (or `src/assets` from sources), as
 * absolute paths, so a session's PATH does not matter.
 */
export function githubHelperCommand(node = process.execPath): string {
  const candidates = [
    join(__dirname, 'assets', GITHUB_HELPER_SCRIPT),
    join(__dirname, '..', '..', 'assets', GITHUB_HELPER_SCRIPT),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) {
    throw new Error(`${GITHUB_HELPER_SCRIPT} not found`);
  }
  for (const path of [node, script]) {
    if (path.includes("'")) {
      throw new Error(`Unsupported path for the GitHub helper: ${path}`);
    }
  }
  return `!'${node}' '${script}'`;
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
 * - the tool `create_pull_request`;
 * - auto-memory per repository: Claude Code keeps its memory per working
 *   directory, i.e. per session clone; all sessions of a repository share
 *   `<memoryDir>/<repository id>` instead (scratch sessions keep Claude
 *   Code's default);
 * - after a `git push` of Claude's, what reached the remote is recorded.
 *
 * Git in session clones uses the user's own credentials (git
 * configuration, credential helpers such as `gh`, SSH keys), as in a
 * terminal; pushes need whatever approval the session's permission mode
 * asks for, like any command.
 */
@Injectable()
export class SessionAgentSupportService extends SessionAgentSupport {
  private readonly logger = new Logger(SessionAgentSupportService.name);
  /** Running `git push` commands of Claude's, by session. */
  private readonly pushes = new Map<string, Set<string>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessionGit: SessionGitService,
    private readonly git: GitService,
    private readonly shownFiles: ShownFilesService,
    @Optional()
    private readonly previews?: PreviewsService,
    @Optional()
    private readonly automation?: SessionAutomationHooks,
    @Optional()
    private readonly githubTokens?: SessionGitHubTokensService,
  ) {
    super();
  }

  override async cleanUpClones(records: SessionRecord[]): Promise<void> {
    await this.removeOldCredentialHelpers(
      records.flatMap((record) =>
        record.directories.filter(
          (directory) =>
            directory.kind === 'clone' && directory.state === 'ready',
        ),
      ),
    );
  }

  private async removeOldCredentialHelpers(
    clones: SessionRecord['directories'],
  ): Promise<void> {
    for (const directory of clones) {
      if (!existsSync(join(directory.path, '.git'))) {
        // Removed from disk meanwhile: nothing to clean up.
        continue;
      }
      try {
        if (await this.git.removeAppCredentialHelper(directory.path)) {
          this.logger.log(
            `Removed the old credential helper of ${directory.path}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Could not remove the old credential helper of ${directory.path}: ${errorText(error)}`,
        );
      }
    }
  }

  async prepare(record: SessionRecord): Promise<LaunchExtras> {
    const clones = record.directories.filter(
      (directory) => directory.kind === 'clone' && directory.state === 'ready',
    );
    // Clones made by earlier versions still name the app's credential
    // helper, which hid the user's own (also removed at startup).
    await this.removeOldCredentialHelpers(clones);
    const githubClones = clones.filter(
      (directory) => directory.repositoryGitHub,
    );
    const settings: Record<string, unknown> = { ...SESSION_SETTINGS };
    const main = record.directories[0];
    if (main?.kind === 'clone' && main.repositoryId) {
      const memory = join(this.config.memoryDir, main.repositoryId);
      await mkdir(memory, { recursive: true });
      // Claude Code writes the memory as the session user.
      await handOverToSession(memory, this.git.launcher);
      settings['autoMemoryDirectory'] = memory;
    }
    const previews = this.previews?.enabled ? this.previews : null;
    const instructions = await this.instructions();
    return {
      ...(instructions ? { instructions } : {}),
      env: this.githubTokenEnvironment(record.id, githubClones.length > 0),
      tools: [
        this.showFileTool(record.id),
        ...(githubClones.length > 0
          ? [
              this.createPullRequestTool(record.id),
              this.requestOwnerDecisionTool(record.id),
            ]
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
        // Only pauses automerge.
        ...(githubClones.length > 0 ? [REQUEST_OWNER_DECISION_TOOL_NAME] : []),
        ...(previews ? [EXPOSE_PORT_TOOL_NAME, STOP_PREVIEW_TOOL_NAME] : []),
      ],
    };
  }

  toolCalled(
    sessionId: string,
    toolName: string,
    input: unknown,
    toolUseId: string,
  ): void {
    const command =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['command']
        : undefined;
    if (
      toolName === 'Bash' &&
      typeof command === 'string' &&
      isGitPushCommand(command)
    ) {
      let pushes = this.pushes.get(sessionId);
      if (!pushes) {
        pushes = new Set();
        this.pushes.set(sessionId, pushes);
      }
      pushes.add(toolUseId);
    }
  }

  toolFinished(sessionId: string, toolUseId: string): void {
    const pushes = this.pushes.get(sessionId);
    if (pushes?.delete(toolUseId)) {
      if (pushes.size === 0) {
        this.pushes.delete(sessionId);
      }
      void this.notePushes(sessionId);
    }
  }

  released(sessionId: string): void {
    this.pushes.delete(sessionId);
    this.githubTokens?.release(sessionId);
  }

  /**
   * In the container (`separate-users`) the session user has no GitHub
   * credentials: `git` and `gh` get installation tokens of the session's
   * repositories from the API instead (see
   * {@link SessionGitHubTokensService}), through the helper
   * `assets/crm-github.cjs`. The credential helper is configured through
   * the environment (`GIT_CONFIG_*`), for every git command of the
   * process, without touching the clones' config; `gh` is a wrapper in
   * the image that runs the helper. On the NixOS service the user's own
   * credentials apply instead.
   */
  private githubTokenEnvironment(
    sessionId: string,
    hasGitHubClones: boolean,
  ): Record<string, string> {
    if (!this.githubTokens || !this.git.launcher.separated) {
      return {};
    }
    // A new process: tokens of an earlier one stop working.
    this.githubTokens.release(sessionId);
    if (!hasGitHubClones) {
      return {};
    }
    return {
      CRM_API_URL: this.config.internalApiUrl,
      CRM_SESSION_TOKEN: this.githubTokens.processTokens.issue(sessionId),
      GIT_CONFIG_COUNT: '3',
      // An empty value first resets helpers from other config files.
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: `${githubHelperCommand()} git-credential`,
      GIT_CONFIG_KEY_2: 'credential.https://github.com.useHttpPath',
      GIT_CONFIG_VALUE_2: 'true',
    };
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
        "session's repositories. Push the branch first (git push). Returns the " +
        'URL of the pull request (or of the open one that exists for the ' +
        'branch already).',
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

  /**
   * The tool `request_owner_decision`: Claude asks for the owner's
   * decision on a review finding; automerge of the session's pull requests
   * pauses until the owner's next message, and the owner is notified. No
   * approval: it only stops the app from merging.
   */
  requestOwnerDecisionTool(sessionId: string): AgentTool {
    return {
      name: REQUEST_OWNER_DECISION_TOOL,
      description:
        'Ask the user to decide before a pull request of this session is merged automatically. ' +
        'Use it when automerge is on and a review finding (or a CI failure) needs the decision ' +
        'of the user instead of yours: a product or design decision, a trade-off, a change of ' +
        'scope, or a finding you think is wrong and would leave unresolved. It pauses automerge ' +
        "of the session's pull requests until the user's next message and notifies the user. " +
        'Then ask your question in your reply and end your turn. Do not use it for findings ' +
        'you can simply fix.',
      inputSchema: (z) => ({
        question: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            'What the user should decide, in one or two sentences; shown in the notification',
          ),
      }),
      handler: async (input) => {
        const question = String(input['question']).replace(/\s+/g, ' ').trim();
        if (!question) {
          return { isError: true, text: 'The question must not be blank.' };
        }
        const hold = this.automation?.holdAutomerge;
        if (!hold) {
          return {
            text: 'Automerge is not available on this server. Ask the user in your reply.',
          };
        }
        return { text: hold(sessionId, question) };
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

  /**
   * The machine's instructions for sessions (`SESSION_INSTRUCTIONS_FILE`),
   * read for every process so that a change applies without a restart.
   */
  private async instructions(): Promise<string | null> {
    const file = this.config.sessionInstructionsFile;
    if (!file) {
      return null;
    }
    try {
      return (await readFile(file, 'utf8')).trim() || null;
    } catch (error) {
      this.logger.warn(
        `Could not read the session instructions ${file}: ${errorText(error)}`,
      );
      return null;
    }
  }

  /** After a push: note what reached the remote. */
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
}
