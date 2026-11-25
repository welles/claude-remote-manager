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
import {
  MAX_PREVIEW_NAME_LENGTH,
  MAX_REVIEW_REPLY_LENGTH,
} from '@claude-remote-manager/shared-types';
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
  MERGE_PULL_REQUEST_TOOL,
  REPLY_TO_REVIEW_THREAD_TOOL,
  REQUEST_OWNER_DECISION_TOOL,
  REQUEST_OWNER_DECISION_TOOL_NAME,
  SET_PR_AUTOMATION_TOOL,
  SHOW_FILE_TOOL,
  SHOW_FILE_TOOL_NAME,
  STOP_PREVIEW_TOOL,
  STOP_PREVIEW_TOOL_NAME,
  isGitPushCommand,
} from './app-tools';
import { SessionAutomationHooks } from './session-automation-hooks';
import { SessionGitService } from './session-git.service';
import { SessionGitHubTokensService } from './session-github-tokens.service';
import { workingDirectoryOf, type SessionRecord } from './session.repository';
import {
  EnvironmentFiles,
  type WrittenFiles,
} from '../environments/environment-files';
import {
  EnvironmentsService,
  type LaunchEnvironment,
} from '../environments/environments.service';

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

/** An Autofix resolve allowed unasked, checked again before resolving. */
interface ResolveGrant {
  toolUseId: string;
  repositoryId: string;
  number: number;
  commentId: number;
  runStartedAt: Date;
  /** The head commit the check saw. */
  headSha: string;
}

/** A `merge_pull_request` allowed unasked: the head commit checked. */
interface MergeGrant {
  toolUseId: string;
  repositoryId: string;
  number: number;
  headSha: string;
}

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
  /**
   * Whether a `reply_to_review_thread` call that resolves may run unasked
   * during an Autofix run that started at `runStartedAt`: only after a
   * push in this run since the thread's last comment. When it may, the
   * tool use `toolUseId` checks it again right before resolving. `false`
   * without integrations.
   */
  mayResolveUnasked(
    sessionId: string,
    input: Record<string, unknown>,
    runStartedAt: Date,
    toolUseId: string,
  ): Promise<boolean> {
    void sessionId;
    void input;
    void runStartedAt;
    void toolUseId;
    return Promise.resolve(false);
  }
  /**
   * Whether a `merge_pull_request` call may run unasked: automerge is on
   * for the pull request and it is ready. When it may, the tool use
   * `toolUseId` merges exactly the head commit checked. `false` without
   * integrations.
   */
  mayMergeUnasked(
    sessionId: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<boolean> {
    void sessionId;
    void input;
    void toolUseId;
    return Promise.resolve(false);
  }
  /** Drops the merge grant of tool use `toolUseId` (it was not used). */
  dropMergeGrant(sessionId: string, toolUseId: string): void {
    void sessionId;
    void toolUseId;
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

/**
 * What Claude is told about the session's environment: its instructions,
 * and the names (never the values) of its variables and files.
 */
export function environmentInstructions(
  environment: LaunchEnvironment,
): string {
  const parts = [`# Environment "${environment.name}"`];
  if (environment.instructions?.trim()) {
    parts.push(environment.instructions.trim());
  }
  const variables = Object.keys(environment.variables);
  if (variables.length > 0) {
    parts.push(
      `The session's environment sets these variables: ${variables.map((name) => `\`${name}\``).join(', ')}.`,
    );
  }
  if (environment.files.length > 0) {
    parts.push(
      `Files of the environment, each path in a variable: ${environment.files
        .map((file) => `\`$${file.variable}\` (${file.fileName})`)
        .join(', ')}. They exist only while this Claude Code process runs.`,
    );
  }
  if (variables.length > 0 || environment.files.length > 0) {
    parts.push(
      'Use them through the variables. Do not print secret values or write them into files that may be committed or shared; the session manager shows secret values as *** to the user.',
    );
  }
  return parts.join('\n\n');
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
 * - the tools `create_pull_request`, `reply_to_review_thread`,
 *   `merge_pull_request`, `set_pr_automation` and `request_owner_decision`;
 * - auto-memory per repository: Claude Code keeps its memory per working
 *   directory, i.e. per session clone; all sessions of a repository share
 *   `<memoryDir>/<repository id>` instead (scratch sessions keep Claude
 *   Code's default);
 * - after a `git push` of Claude's, what reached the remote is recorded.
 *
 * Git in session clones uses the user's own credentials (git
 * configuration, credential helpers such as `gh`, SSH keys), as in a
 * terminal; in the container, where the session user has none, installation
 * tokens of the app instead (see {@link SessionGitHubTokensService}).
 * Pushes need whatever approval the session's permission mode asks for,
 * like any command.
 */
@Injectable()
export class SessionAgentSupportService extends SessionAgentSupport {
  private readonly logger = new Logger(SessionAgentSupportService.name);
  /** Running `git push` commands of Claude's, by session. */
  private readonly pushes = new Map<string, Set<string>>();
  /** Directory of the environment files of the running process, by session. */
  private readonly filesByProcess = new Map<string, WrittenFiles>();
  /** Resolves an Autofix run allowed unasked, by session. */
  private readonly resolveGrants = new Map<string, ResolveGrant[]>();
  /** Merges allowed unasked (automerge), by session. */
  private readonly mergeGrants = new Map<string, MergeGrant[]>();

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
    @Optional()
    private readonly environments?: EnvironmentsService,
    @Optional()
    private readonly environmentFiles?: EnvironmentFiles,
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
    // The memory of the working directory's repository.
    const main = workingDirectoryOf(record);
    if (main?.kind === 'clone' && main.repositoryId) {
      const memory = join(this.config.memoryDir, main.repositoryId);
      await mkdir(memory, { recursive: true });
      // Claude Code writes the memory as the session user.
      await handOverToSession(memory, this.git.launcher);
      settings['autoMemoryDirectory'] = memory;
    }
    const previews = this.previews?.enabled ? this.previews : null;
    const environment = await this.environmentFor(record);
    const instructions = [await this.instructions(), environment.instructions]
      .filter((text): text is string => !!text)
      .join('\n\n');
    return {
      ...(instructions ? { instructions } : {}),
      env: {
        // The app's own variables win (an environment cannot set them).
        ...environment.env,
        ...this.githubTokenEnvironment(record.id, githubClones.length > 0),
      },
      tools: [
        this.showFileTool(record.id),
        ...(githubClones.length > 0
          ? [
              this.createPullRequestTool(record.id),
              this.replyToReviewThreadTool(record.id),
              this.mergePullRequestTool(record.id),
              this.setPrAutomationTool(record.id),
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
    this.resolveGrants.delete(sessionId);
    this.mergeGrants.delete(sessionId);
    this.githubTokens?.release(sessionId);
    this.releaseEnvironmentFiles(sessionId);
  }

  /**
   * Variables, files and instructions of the session's environment for a
   * new process. The files of an earlier process are removed first.
   */
  private async environmentFor(
    record: SessionRecord,
  ): Promise<{ env: Record<string, string>; instructions: string | null }> {
    this.releaseEnvironmentFiles(record.id);
    const environment = this.environments?.forLaunch(record.environmentId);
    if (!environment || !this.environmentFiles) {
      return { env: {}, instructions: null };
    }
    const written = await this.environmentFiles.write(
      record.id,
      environment.files,
    );
    if (written) {
      this.filesByProcess.set(record.id, written);
    }
    return {
      env: { ...environment.variables, ...(written?.env ?? {}) },
      instructions: environmentInstructions(environment),
    };
  }

  private releaseEnvironmentFiles(sessionId: string): void {
    const written = this.filesByProcess.get(sessionId);
    if (written) {
      this.filesByProcess.delete(sessionId);
      this.environmentFiles?.remove(written).catch((error: unknown) => {
        this.logger.warn(
          `Could not remove the environment files ${written.dir}: ${errorText(error)}`,
        );
      });
    }
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
        'branch already). When the session has several clones of the ' +
        'repository (add_branch), name the branch of the clone.',
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
        branch: z
          .string()
          .max(200)
          .optional()
          .describe(
            'The session branch (head) of the pull request, e.g. claude/<session>-2; needed only when the session has several clones of the repository',
          ),
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
          typeof input['branch'] === 'string' ? input['branch'] : null,
        );
        return {
          text: `Pull request #${pull.number} (${pull.state}) of ${pull.repository}: ${pull.url}`,
        };
      },
    };
  }

  /**
   * The tool `reply_to_review_thread` of a session: a reply on a review
   * thread of one of the session's own pull requests and/or its
   * resolution, done by the backend with an installation token for that
   * repository (`gh` in sessions stays read-only). Asks as the permission
   * mode says, except during an Autofix run (see `SessionsService`).
   */
  replyToReviewThreadTool(sessionId: string): AgentTool {
    return {
      name: REPLY_TO_REVIEW_THREAD_TOOL,
      description:
        "Reply on a review thread of one of this session's own pull requests on GitHub, and/or " +
        'resolve the thread. Name the thread by the numeric REST ID of any review comment in it ' +
        '(the `id` that `gh api repos/{owner}/{repo}/pulls/{number}/comments` lists, or the ' +
        'comment-id the session manager gives with review feedback). Use it after fixing a ' +
        'review finding: reply with what changed (name the commit) and resolve the thread. ' +
        'For a finding you did not fix, reply with the reason and leave the thread unresolved. ' +
        'Only pull requests of this session; gh itself can only read.',
      inputSchema: (z) => ({
        repository: z
          .string()
          .max(200)
          .optional()
          .describe(
            'owner/name of the repository; may be omitted if the session has only one GitHub repository',
          ),
        pull_request: z
          .number()
          .int()
          .positive()
          .describe('Number of the pull request'),
        comment_id: z
          .number()
          .int()
          .positive()
          .describe('REST ID of a review comment in the thread'),
        body: z
          .string()
          .max(MAX_REVIEW_REPLY_LENGTH)
          .optional()
          .describe('The reply in Markdown; omit to only resolve'),
        resolve: z
          .boolean()
          .optional()
          .describe('Resolve the thread as well (default: false)'),
      }),
      handler: async (input, { toolUseId }) => {
        try {
          const repositoryId = this.repositoryOf(
            sessionId,
            typeof input['repository'] === 'string'
              ? input['repository']
              : null,
          );
          const number = Number(input['pull_request']);
          const commentId = Number(input['comment_id']);
          const grant = this.takeResolveGrant(
            sessionId,
            toolUseId,
            repositoryId,
            number,
            commentId,
          );
          const outcome = await this.sessionGit.replyToReviewThread(
            sessionId,
            repositoryId,
            {
              number,
              commentId,
              body: typeof input['body'] === 'string' ? input['body'] : null,
              resolve: input['resolve'] === true,
              // Allowed unasked by the Autofix check: it must still hold
              // (no newer comment, the same head) when resolving.
              ...(grant
                ? {
                    beforeResolve: async () =>
                      (await this.sessionGit.mayResolveUnasked(
                        sessionId,
                        repositoryId,
                        number,
                        commentId,
                        grant.runStartedAt,
                      )) === grant.headSha,
                  }
                : {}),
            },
          );
          return {
            text: [
              outcome.replyUrl
                ? `Replied on the review thread of ${outcome.pullRequest}: ${outcome.replyUrl}.`
                : null,
              outcome.resolved === 'resolved'
                ? `Resolved the thread on ${outcome.pullRequest}.`
                : outcome.resolved === 'already'
                  ? `The thread on ${outcome.pullRequest} was resolved already.`
                  : outcome.resolved === 'withheld'
                    ? `Did not resolve the thread on ${outcome.pullRequest}: the condition for resolving without approval no longer holds (a newer comment, or the pull request's head changed since your push). It stays unresolved; push again or leave it to the user.`
                    : null,
            ]
              .filter(Boolean)
              .join(' '),
          };
        } catch (error) {
          return {
            isError: true,
            text: `reply_to_review_thread failed: ${errorText(error)}`,
          };
        }
      },
    };
  }

  /**
   * The tool `merge_pull_request` of a session: merges one of the session's
   * own pull requests, done by the backend with an installation token for
   * that repository. Asks as the permission mode says; unasked when
   * automerge is on for the pull request and it is ready (see
   * `SessionsService`), and then merges exactly the head commit checked.
   */
  mergePullRequestTool(sessionId: string): AgentTool {
    return {
      name: MERGE_PULL_REQUEST_TOOL,
      description:
        "Merge one of this session's own pull requests on GitHub. Merge only when the user " +
        'asked you to, or when automerge is on for the pull request (shown in the session ' +
        "manager's messages): it then runs without approval if all checks of the head commit " +
        'passed, nobody requests changes, there are no new reviews or comments to handle and ' +
        'no review thread is unresolved; otherwise the user is asked as the permission mode ' +
        'says. Without method: rebase, else squash, a merge commit only when neither is ' +
        'possible. GitHub may still refuse (conflict, branch protection, draft). Where the ' +
        "base branch requires a merge queue, it adds the pull request to the queue's end " +
        "instead (the queue's settings decide the method) and GitHub merges it once the " +
        "queue's checks pass; if the queue removes it, the session manager tells you.",
      inputSchema: (z) => ({
        repository: z
          .string()
          .max(200)
          .optional()
          .describe(
            'owner/name of the repository; may be omitted if the session has only one GitHub repository',
          ),
        pull_request: z
          .number()
          .int()
          .positive()
          .describe('Number of the pull request'),
        method: z
          .enum(['rebase', 'squash', 'merge'])
          .optional()
          .describe(
            'How to merge; default: rebase, else squash, else a merge commit',
          ),
      }),
      handler: async (input, { toolUseId }) => {
        try {
          const repositoryId = this.repositoryOf(
            sessionId,
            typeof input['repository'] === 'string'
              ? input['repository']
              : null,
          );
          const number = Number(input['pull_request']);
          const grant = this.takeMergeGrant(
            sessionId,
            toolUseId,
            repositoryId,
            number,
          );
          if (grant) {
            // Allowed unasked by the automerge check: it must still hold
            // (no change request, thread or pause since), for the same head.
            const again = await this.automation?.mayMergeUnasked?.(
              sessionId,
              repositoryId,
              number,
            );
            if (again !== grant.headSha) {
              return {
                isError: true,
                text: 'merge_pull_request did not merge: the pull request is no longer ready for a merge without approval (a new review, comment, thread, push or pause since the check). Look at it again; call the tool again to merge (it then asks as the permission mode says, unless it is ready again).',
              };
            }
          }
          const method = input['method'];
          const outcome = await this.sessionGit.mergePullRequest(
            sessionId,
            repositoryId,
            number,
            {
              sha: grant?.headSha ?? null,
              method:
                method === 'rebase' || method === 'squash' || method === 'merge'
                  ? method
                  : null,
            },
          );
          if (outcome.kind === 'queued') {
            const place =
              outcome.position === null
                ? ''
                : ` at position ${outcome.position}`;
            return {
              text: `${outcome.already ? 'Already in' : 'Added to'} the merge queue: ${outcome.pullRequest} at ${outcome.sha.slice(0, 12)}${place}. Its base branch requires a merge queue, so GitHub merges it once the queue's checks pass (the queue decides the method). It is not merged yet. If you wait for it, say so with set_waiting_state "work": the session manager then wakes you when it is merged or the queue removes it (the user is notified of a removal in any case).`,
            };
          }
          return {
            text: `Merged ${outcome.pullRequest} at ${outcome.sha.slice(0, 12)} (${outcome.method === 'merge' ? 'merge commit' : outcome.method}).`,
          };
        } catch (error) {
          return {
            isError: true,
            text: `merge_pull_request failed: ${errorText(error)}`,
          };
        }
      },
    };
  }

  /**
   * The tool `set_pr_automation`: switches autofix, automerge or autoclose
   * of one of the session's open pull requests, like the switches of the
   * session view. Asks as the permission mode says; during an Autofix run
   * it can only turn switches off (see `PrAutomationService`).
   */
  setPrAutomationTool(sessionId: string): AgentTool {
    return {
      name: SET_PR_AUTOMATION_TOOL,
      description:
        "Turn autofix, automerge or autoclose of one of this session's open pull requests on " +
        'or off, like the switches the user has in the session view. Turn them on only when ' +
        'the user asked you to. Autofix continues the session when CI fails or reviewers ' +
        'comment; automerge (needs autofix, turns it on) merges the pull request once all ' +
        'checks passed, nobody requests changes and no review thread is open; autoclose ends ' +
        'the session when its last open pull request is merged or closed. Omitted switches ' +
        'stay as they are. During an Autofix run switches can only be turned off.',
      inputSchema: (z) => ({
        repository: z
          .string()
          .max(200)
          .optional()
          .describe(
            'owner/name of the repository; may be omitted if the session has only one GitHub repository',
          ),
        pull_request: z
          .number()
          .int()
          .positive()
          .describe('Number of the pull request'),
        autofix: z.boolean().optional().describe('Turn autofix on or off'),
        automerge: z
          .boolean()
          .optional()
          .describe('Turn automerge on (turns autofix on too) or off'),
        autoclose: z.boolean().optional().describe('Turn autoclose on or off'),
      }),
      handler: async (input) => {
        const set = this.automation?.setAutomation;
        if (!set) {
          return {
            isError: true,
            text: 'The PR automation is not available on this server. Ask the user to switch it in the session view.',
          };
        }
        try {
          const repositoryId = this.repositoryOf(
            sessionId,
            typeof input['repository'] === 'string'
              ? input['repository']
              : null,
          );
          const flag = (name: string) =>
            typeof input[name] === 'boolean'
              ? (input[name] as boolean)
              : undefined;
          return {
            text: set(sessionId, repositoryId, Number(input['pull_request']), {
              autofix: flag('autofix'),
              automerge: flag('automerge'),
              autoclose: flag('autoclose'),
            }),
          };
        } catch (error) {
          return {
            isError: true,
            text: `set_pr_automation failed: ${errorText(error)}`,
          };
        }
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

  override async mayResolveUnasked(
    sessionId: string,
    input: Record<string, unknown>,
    runStartedAt: Date,
    toolUseId: string,
  ): Promise<boolean> {
    const number = input['pull_request'];
    const commentId = input['comment_id'];
    if (
      typeof number !== 'number' ||
      typeof commentId !== 'number' ||
      !Number.isSafeInteger(number) ||
      !Number.isSafeInteger(commentId)
    ) {
      return false;
    }
    const repositoryId = this.repositoryOf(
      sessionId,
      typeof input['repository'] === 'string' ? input['repository'] : null,
    );
    const headSha = await this.sessionGit.mayResolveUnasked(
      sessionId,
      repositoryId,
      number,
      commentId,
      runStartedAt,
    );
    if (!headSha) {
      return false;
    }
    let grants = this.resolveGrants.get(sessionId);
    if (!grants) {
      grants = [];
      this.resolveGrants.set(sessionId, grants);
    }
    grants.push({
      toolUseId,
      repositoryId,
      number,
      commentId,
      runStartedAt,
      headSha,
    });
    return true;
  }

  override async mayMergeUnasked(
    sessionId: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<boolean> {
    const check = this.automation?.mayMergeUnasked;
    const number = input['pull_request'];
    if (
      !check ||
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1
    ) {
      return false;
    }
    const repositoryId = this.repositoryOf(
      sessionId,
      typeof input['repository'] === 'string' ? input['repository'] : null,
    );
    const headSha = await check(sessionId, repositoryId, number);
    if (!headSha) {
      return false;
    }
    let grants = this.mergeGrants.get(sessionId);
    if (!grants) {
      grants = [];
      this.mergeGrants.set(sessionId, grants);
    }
    grants.push({ toolUseId, repositoryId, number, headSha });
    return true;
  }

  override dropMergeGrant(sessionId: string, toolUseId: string): void {
    const grants = this.mergeGrants.get(sessionId);
    const index = grants?.findIndex((grant) => grant.toolUseId === toolUseId);
    if (grants && index !== undefined && index >= 0) {
      grants.splice(index, 1);
      if (grants.length === 0) {
        this.mergeGrants.delete(sessionId);
      }
    }
  }

  /**
   * The grant of a merge allowed unasked for this call (its pull request,
   * and its tool use if known), taken out of the list.
   */
  private takeMergeGrant(
    sessionId: string,
    toolUseId: string | null,
    repositoryId: string,
    number: number,
  ): MergeGrant | null {
    const grants = this.mergeGrants.get(sessionId) ?? [];
    const index = grants.findIndex(
      (grant) =>
        grant.repositoryId === repositoryId &&
        grant.number === number &&
        (!toolUseId || grant.toolUseId === toolUseId),
    );
    if (index < 0) {
      return null;
    }
    const [grant] = grants.splice(index, 1);
    if (grants.length === 0) {
      this.mergeGrants.delete(sessionId);
    }
    return grant;
  }

  /**
   * The grant of an Autofix resolve allowed unasked for this call (by its
   * tool use, else by thread), taken out of the list.
   */
  private takeResolveGrant(
    sessionId: string,
    toolUseId: string | null,
    repositoryId: string,
    number: number,
    commentId: number,
  ): ResolveGrant | null {
    const grants = this.resolveGrants.get(sessionId) ?? [];
    const index = grants.findIndex((grant) =>
      toolUseId
        ? grant.toolUseId === toolUseId
        : grant.repositoryId === repositoryId &&
          grant.number === number &&
          grant.commentId === commentId,
    );
    if (index < 0) {
      return null;
    }
    const [grant] = grants.splice(index, 1);
    if (grants.length === 0) {
      this.resolveGrants.delete(sessionId);
    }
    return grant;
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
    // Several clones of one repository (add_branch) are one repository.
    const repositories = [
      ...new Map(
        candidates.map((directory) => [directory.repositoryId, directory]),
      ).values(),
    ];
    const matches = name
      ? repositories.filter(
          (directory) =>
            directory.repositoryName?.toLowerCase() === name.toLowerCase(),
        )
      : repositories;
    if (matches.length !== 1) {
      const names = repositories
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
            directory.branch,
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
