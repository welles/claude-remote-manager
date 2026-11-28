import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionPermissionMode } from '@claude-remote-manager/shared-types';
import type { ProcessLauncher } from '../../common/process-isolation';
import type {
  AgentAccount,
  AgentProbe,
  AgentReviewOptions,
  AgentReviewResult,
  AgentRun,
  AgentRunner,
  AgentStartOptions,
  AgentTool,
  AgentUserMessage,
} from '../agent-runner';
import type {
  AgentApprovalResult,
  AgentEvent,
  AgentHistoryEntry,
} from '../agent-events';
import { AsyncQueue } from '../async-queue';
import { loadZod } from '../sdk-agent-runner';
import type { TranscriptReader } from '../transcript-reader';
import { CodexAppServer } from './codex-app-server';
import {
  CODEX_APP_INPUT_PREFIX,
  CODEX_APP_TOOL_NAMESPACE,
  CodexEventTranslator,
  codexContextUsage,
  codexHistory,
  codexModel,
  codexPlanUsage,
  codexToolName,
  unwrapShellCommand,
} from './codex-events';
import type {
  CodexApprovalPolicy,
  CodexFileUpdateChange,
  CodexModel,
  CodexRateLimitSnapshot,
  CodexThreadItem,
  CodexThreadStartResponse,
  CodexTurn,
  CodexUserInput,
} from './codex-protocol';

/** Codex's approval policy for a session's mode (its own modes). */
export function codexPolicy(mode: SessionPermissionMode): CodexApprovalPolicy {
  return mode === 'on-request' || mode === 'never' ? mode : 'untrusted';
}

/**
 * Configuration every thread gets: Codex reads a repository's `CLAUDE.md`
 * where it has no `AGENTS.md` (project instructions written for Claude
 * Code apply to Codex sessions of the repository too).
 */
export const CODEX_THREAD_CONFIG = {
  project_doc_fallback_filenames: ['CLAUDE.md'],
};

/** The text and image inputs of a message: only what the user wrote. */
export function codexInput(message: AgentUserMessage): CodexUserInput[] {
  return [
    ...(message.images ?? []).map(
      (image): CodexUserInput => ({
        type: 'image',
        url: `data:${image.mediaType};base64,${image.data}`,
      }),
    ),
    ...(message.text
      ? [{ type: 'text', text: message.text, text_elements: [] }]
      : []),
  ] as CodexUserInput[];
}

/** One fragment of a turn's `additionalContext`. */
export interface CodexContextEntry {
  kind: 'untrusted' | 'application';
  value: string;
  /** Labels untrusted content (`[a-z][a-z0-9_]{0,63}`). */
  name?: string;
}

/**
 * A message's context and note as Codex's additional context of the turn,
 * not as input: the untrusted context (GitHub content) as `untrusted`
 * (Codex hands it to the model as a tool output, not as the user's
 * words), the app's note as `application` (a developer message). Neither
 * is a user message of the thread, so the history shows only what the
 * user typed. `undefined`: none.
 */
export function codexAdditionalContext(
  message: AgentUserMessage,
): Record<string, CodexContextEntry> | undefined {
  const entries: Record<string, CodexContextEntry> = {};
  if (message.context) {
    entries['crm_context'] = {
      kind: 'untrusted',
      value: message.context.text,
      name: 'github',
    };
  }
  if (message.note) {
    entries['crm_note'] = { kind: 'application', value: message.note.text };
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

/** Shell syntax that makes a command more than one simple command. */
const COMPOUND = /[;&|<>`$()\n\\]/;

/**
 * Whether a command is allowed by one of the session's Bash rules (as
 * "Allow for this session" stores them, in Claude Code's syntax):
 * `Bash(<command>)` exactly, `Bash(<prefix>:*)` for the command and its
 * arguments, `Bash(<pattern with *>)` as a wildcard. Prefixes and
 * wildcards only match a single simple command (no operators, expansions
 * or redirections), so an allowed `git status:*` does not allow
 * `git status; rm -rf ~`.
 */
export function matchesBashRule(
  command: string,
  rules: readonly string[],
): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  for (const rule of rules) {
    const match = /^Bash\((.+)\)$/s.exec(rule);
    if (!match) {
      continue;
    }
    const content = match[1].trim();
    if (!content || content === '*' || content === ':*') {
      continue;
    }
    if (content === trimmed) {
      return true;
    }
    if (COMPOUND.test(trimmed)) {
      continue;
    }
    if (content.endsWith(':*')) {
      const prefix = content.slice(0, -2).trim();
      if (prefix && (trimmed === prefix || trimmed.startsWith(`${prefix} `))) {
        return true;
      }
    } else if (content.includes('*')) {
      const parts = content
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (new RegExp(`^${parts.join('.*')}$`, 's').test(trimmed)) {
        return true;
      }
    }
  }
  return false;
}

/** Found rollouts by home and thread (a thread keeps its file). */
const rollouts = new Map<string, string>();

/**
 * The rollout file of a thread under a Codex home's `sessions/` (shared by
 * all accounts): Codex resumes a thread of another account by its path.
 * A found path is remembered until the file is gone (e.g. compressed).
 */
export async function findRollout(
  home: string,
  threadId: string,
): Promise<string | null> {
  const key = `${home}\0${threadId}`;
  const known = rollouts.get(key);
  if (known) {
    try {
      await access(known);
      return known;
    } catch {
      rollouts.delete(key);
    }
  }
  const found = await scanRollouts(home, threadId);
  if (found) {
    rollouts.set(key, found);
  }
  return found;
}

async function scanRollouts(
  home: string,
  threadId: string,
): Promise<string | null> {
  const root = join(home, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const visit = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Newest first: years, months and days sort by name.
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        const found = await visit(path, depth + 1);
        if (found) {
          return found;
        }
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        (entry.name.endsWith(suffix) || entry.name.endsWith(`${suffix}.zst`))
      ) {
        return path;
      }
    }
    return null;
  };
  return visit(root, 0);
}

/**
 * Configuration that keeps the user's MCP servers from starting, for a
 * process that only reads a thread: each configured server disabled by
 * name (Codex merges the overrides into its configuration).
 */
async function withoutMcpServers(
  server: CodexAppServer,
): Promise<Record<string, boolean>> {
  try {
    const answer = await server.request<{
      config?: { mcp_servers?: Record<string, unknown> | null };
    }>('config/read', {});
    return Object.fromEntries(
      Object.keys(answer.config?.mcp_servers ?? {}).map((name) => [
        `mcp_servers.${name}.enabled`,
        false,
      ]),
    );
  } catch {
    return {};
  }
}

/** Where the runner finds Codex. */
export interface CodexRunnerConfig {
  executable: string;
  /** The Codex home whose `sessions/` all accounts share (history reads). */
  baseHome: string;
  /**
   * The machine's rules for all sessions that Claude Code reads itself as
   * managed policy (`/etc/claude-code/CLAUDE.md` in the image); Codex gets
   * them first in its developer instructions (`CODEX_INSTRUCTIONS_FILE`).
   */
  instructionsFile?: string | null;
}

/**
 * Starts Codex processes (`codex app-server`) for sessions, one thread per
 * session, as the session user with the account's Codex home: the Codex
 * adapter of the engine-neutral core.
 */
@Injectable()
export class CodexRunner implements AgentRunner {
  constructor(
    private readonly config: CodexRunnerConfig,
    private readonly launcher: ProcessLauncher,
  ) {}

  async start(
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<AgentRun> {
    return CodexProcess.start(
      this.config,
      this.launcher,
      options,
      firstMessage,
    );
  }

  async probe<T>(
    task: (probe: AgentProbe) => Promise<T>,
    account?: AgentAccount,
  ): Promise<T> {
    const server = await CodexAppServer.start({
      executable: this.config.executable,
      launcher: this.launcher,
      home: account?.configDir ?? this.config.baseHome,
      cwd: tmpdir(),
    });
    try {
      return await task({
        supportedModels: async () => {
          const models: CodexModel[] = [];
          let cursor: string | null = null;
          // Page by page; a cursor seen before ends it (never loops).
          const seen = new Set<string>();
          do {
            const answer: { data: CodexModel[]; nextCursor?: string | null } =
              await server.request('model/list', cursor ? { cursor } : {});
            models.push(...answer.data);
            cursor = answer.nextCursor ?? null;
            if (cursor !== null && seen.has(cursor)) {
              break;
            }
            if (cursor !== null) {
              seen.add(cursor);
            }
          } while (cursor !== null);
          return models.filter((model) => !model.hidden).map(codexModel);
        },
        supportedCommands: async () => [],
        planUsage: async () => readPlanUsage(server),
      });
    } finally {
      server.close();
    }
  }

  review(_options: AgentReviewOptions): Promise<AgentReviewResult> {
    return Promise.reject(
      new Error('Independent reviews do not run with Codex yet'),
    );
  }

  /**
   * Reads a thread's history (any account's, through the shared
   * rollouts). Codex knows a thread of another home only once it resumed
   * it by its path; the process runs in the temporary directory and the
   * thread keeps its own working directory (which may be gone: the
   * session's first directory, removed since), without the user's MCP
   * servers and without the turns in the resume's answer.
   */
  async history(threadId: string): Promise<AgentHistoryEntry[]> {
    const path = await findRollout(this.config.baseHome, threadId);
    if (!path) {
      return [];
    }
    const server = await CodexAppServer.start({
      executable: this.config.executable,
      launcher: this.launcher,
      home: this.config.baseHome,
      cwd: tmpdir(),
    });
    try {
      await server.request('thread/resume', {
        threadId,
        path,
        excludeTurns: true,
        config: await withoutMcpServers(server),
      });
      const answer = await server.request<{
        thread: { turns?: CodexTurn[] };
      }>('thread/read', { threadId, includeTurns: true });
      return codexHistory(answer.thread.turns ?? []);
    } finally {
      server.close();
    }
  }
}

/** The plan limits, the main bucket where Codex reports buckets. */
async function readPlanUsage(server: CodexAppServer) {
  const answer = await server.request<{
    rateLimits: CodexRateLimitSnapshot;
    rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
  }>('account/rateLimits/read', {});
  return codexPlanUsage(answer.rateLimits, answer.rateLimitsByLimitId);
}

/** Codex's history reader (see `TranscriptReader`). */
export class CodexTranscriptReader implements TranscriptReader {
  constructor(
    private readonly runner: CodexRunner,
    private readonly baseHome: string,
  ) {}

  read(threadId: string): Promise<AgentHistoryEntry[]> {
    return this.runner.history(threadId);
  }

  async exists(threadId: string): Promise<boolean> {
    return (await findRollout(this.baseHome, threadId)) !== null;
  }

  async stamp(threadId: string): Promise<string | null> {
    const path = await findRollout(this.baseHome, threadId);
    if (!path) {
      return null;
    }
    const info = await stat(path);
    return `${info.size}@${info.mtimeMs}`;
  }
}

/** Input of the app's own sent into a running turn (see `steer`). */
const APP_INPUT_TEXT =
  '[Message from the session manager, not from the user: see its note.]';

/** One running Codex process with its thread. */
class CodexProcess implements AgentRun {
  private readonly logger = new Logger('CodexProcess');
  private readonly queue = new AsyncQueue<AgentEvent[]>();
  private readonly pending: AgentUserMessage[] = [];
  /** The changes of running `fileChange` items (for their approval). */
  private readonly fileChanges = new Map<string, CodexFileUpdateChange[]>();
  /** Open server requests by JSON-RPC ID: aborted once Codex resolves one. */
  private readonly openRequests = new Map<number | string, AbortController>();
  /** Bash rules allowed for this session (stored ones and new ones). */
  private readonly bashRules: string[];
  /**
   * What the app tells Codex with the next turn, when it could not tell
   * the turn it belonged to (it had ended).
   */
  private readonly appNotes: string[] = [];
  /** Notifications that came before the thread was known. */
  private readonly early: [string, unknown][] = [];
  private server!: CodexAppServer;
  private translator!: CodexEventTranslator;
  private threadId = '';
  /** The running turn's ID, `starting` until Codex named it. */
  private turnId: string | null = null;
  /** Counts turn/start requests: only the latest one's answer counts. */
  private turnStarts = 0;
  /** An interrupt asked for before the turn had its ID. */
  private interruptWanted = false;
  private model: string | null;
  private policy: CodexApprovalPolicy;
  private closed = false;

  private constructor(
    private readonly config: CodexRunnerConfig,
    private readonly launcher: ProcessLauncher,
    private readonly options: AgentStartOptions,
  ) {
    this.model = options.model;
    this.policy = codexPolicy(options.permissionMode);
    this.bashRules = (options.allowedTools ?? []).filter((rule) =>
      rule.startsWith('Bash('),
    );
  }

  static async start(
    config: CodexRunnerConfig,
    launcher: ProcessLauncher,
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<CodexProcess> {
    const run = new CodexProcess(config, launcher, options);
    try {
      await run.open();
    } catch (error) {
      // The app server may run already (e.g. a refused thread/resume).
      run.close();
      throw error;
    }
    run.send(firstMessage);
    return run;
  }

  /** Passes events on, unless the process was closed meanwhile. */
  private emit(events: AgentEvent[]): void {
    if (!this.queue.isClosed) {
      this.queue.push(events);
    }
  }

  get events(): AsyncIterable<AgentEvent[]> {
    return this.queue;
  }

  private async open(): Promise<void> {
    const home = this.options.account?.configDir ?? this.config.baseHome;
    this.server = await CodexAppServer.start({
      executable: this.config.executable,
      launcher: this.launcher,
      home,
      env: this.options.env,
      cwd: this.options.cwd,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params, id) => this.serverRequest(method, params, id),
      onExit: (error) => {
        if (error && !this.closed) {
          this.queue.fail(error);
        } else {
          this.queue.close();
        }
      },
    });
    const developerInstructions = [
      await machineInstructions(this.config.instructionsFile ?? null),
      this.options.instructions ?? null,
    ]
      .filter((part): part is string => !!part)
      .join('\n\n');
    const common = {
      cwd: this.options.cwd,
      // Full access, as Claude Code has; asking is the approval policy's.
      sandbox: 'danger-full-access',
      approvalPolicy: this.policy,
      config: CODEX_THREAD_CONFIG,
      ...(this.model ? { model: this.model } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };
    let started: CodexThreadStartResponse;
    if (this.options.resume) {
      // The thread keeps the tools it started with: Codex takes dynamic
      // tools only at thread/start (the app gives every thread all of its
      // tools, see `AgentEngine.fixedTools`).
      const path = await findRollout(home, this.options.resume);
      started = await this.server.request<CodexThreadStartResponse>(
        'thread/resume',
        {
          ...common,
          threadId: this.options.resume,
          ...(path ? { path } : {}),
        },
      );
    } else {
      started = await this.server.request<CodexThreadStartResponse>(
        'thread/start',
        { ...common, dynamicTools: await dynamicTools(this.options.tools) },
      );
    }
    this.threadId = started.thread.id;
    this.translator = new CodexEventTranslator(
      this.threadId,
      started.model ?? started.thread.model ?? 'codex',
      this.options.usageBaseline ?? {},
    );
    this.emit([
      {
        type: 'started',
        engineSessionId: this.threadId,
        permissionMode: null,
        terminalCommands: [],
      },
    ]);
    for (const [method, params] of this.early.splice(0)) {
      this.notification(method, params);
    }
  }

  send(message: AgentUserMessage): void {
    if (this.turnId !== null) {
      // Codex runs one turn at a time: queued until the turn ends.
      this.pending.push(message);
      return;
    }
    this.startTurn(message);
  }

  private startTurn(message: AgentUserMessage): void {
    const start = ++this.turnStarts;
    this.turnId = 'starting';
    this.interruptWanted = false;
    const context = {
      ...(codexAdditionalContext(message) ?? {}),
      ...this.takeAppNotes(),
    };
    this.server
      .request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId,
        clientUserMessageId: message.id,
        input: codexInput(message),
        ...(Object.keys(context).length > 0
          ? { additionalContext: context }
          : {}),
        approvalPolicy: this.policy,
        ...(this.model ? { model: this.model } : {}),
      })
      .then((answer) => {
        // Only this request's turn, if no notification named it already
        // (or ended it, and a newer turn is starting).
        if (start === this.turnStarts && this.turnId === 'starting') {
          this.turnKnown(answer.turn.id);
        }
      })
      .catch((error: unknown) => {
        if (start !== this.turnStarts) {
          return;
        }
        this.turnId = null;
        this.interruptWanted = false;
        // One error: the result's text is shown as the turn's error.
        this.emit([
          this.failedResult(
            `Codex did not start the turn: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ]);
        // Messages queued behind it are not left waiting.
        const next = this.pending.shift();
        if (next && this.server.running) {
          this.startTurn(next);
        }
      });
  }

  /** The running turn has its ID: an interrupt asked for meanwhile is sent. */
  private turnKnown(turnId: string): void {
    this.turnId = turnId;
    if (this.interruptWanted) {
      this.interruptWanted = false;
      void this.sendInterrupt(turnId);
    }
  }

  private failedResult(text: string): AgentEvent {
    return {
      type: 'result',
      subtype: 'success',
      isError: true,
      text,
      errors: [],
      durationMs: 0,
      numTurns: 1,
      usage: {},
      engineSessionId: this.threadId,
      queuedTurns: this.pending.length,
    };
  }

  private notification(method: string, params: unknown): void {
    if (!this.translator) {
      // Before the thread is known (e.g. the usage Codex restores right
      // after `thread/resume`, in the same chunk as its answer): kept.
      this.early.push([method, params]);
      return;
    }
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'serverRequest/resolved') {
      // Codex settled a request itself (e.g. the turn ended): the app
      // stops waiting for the user.
      const id = p['requestId'];
      if (typeof id === 'number' || typeof id === 'string') {
        this.openRequests.get(id)?.abort();
      }
      return;
    }
    const threadId = p['threadId'];
    if (typeof threadId === 'string' && threadId !== this.threadId) {
      // Another thread's (a subagent's) turns are not this thread's: they
      // must not end the running turn or start a queued message.
      return;
    }
    const item = p['item'] as CodexThreadItem | undefined;
    if (method === 'item/started' && item?.type === 'fileChange') {
      // Kept for the approval of the change.
      this.fileChanges.set(
        item.id,
        (item as { changes: CodexFileUpdateChange[] }).changes,
      );
    }
    if (method === 'item/completed' && item) {
      this.fileChanges.delete(item.id);
    }
    if (method === 'turn/started') {
      this.turnKnown((p['turn'] as { id: string }).id);
    }
    const events = this.translator.translate(method, params);
    if (method === 'turn/completed') {
      this.turnId = null;
      this.interruptWanted = false;
      this.fileChanges.clear();
      const next = this.pending.shift();
      for (const event of events) {
        if (event.type === 'result') {
          event.queuedTurns = this.pending.length + (next ? 1 : 0);
        }
      }
      if (events.length > 0) {
        this.emit(events);
      }
      if (next) {
        this.startTurn(next);
      }
      return;
    }
    if (events.length > 0) {
      this.emit(events);
    }
  }

  private async serverRequest(
    method: string,
    params: unknown,
    id: number | string,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.openRequests.set(id, controller);
    try {
      return await this.answerRequest(
        method,
        (params ?? {}) as Record<string, unknown>,
        controller.signal,
      );
    } finally {
      this.openRequests.delete(id);
    }
  }

  private async answerRequest(
    method: string,
    p: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const base = {
      title: null,
      displayName: null,
      decisionReason: null,
      blockedPath: null,
      agentId: null,
      suppressAlwaysAllow: false,
      signal,
    };
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const raw = typeof p['command'] === 'string' ? p['command'] : '';
        const actions = Array.isArray(p['commandActions'])
          ? (p['commandActions'] as { command?: unknown }[])
          : null;
        // What the model wrote, not the shell Codex wraps it in.
        const command = unwrapShellCommand(raw, actions);
        if (command && matchesBashRule(command, this.bashRules)) {
          // Allowed for the session earlier (also by an earlier process).
          return { decision: 'accept' };
        }
        const result = await this.options.approve({
          ...base,
          toolName: 'Bash',
          input: { command, cwd: p['cwd'] ?? this.options.cwd },
          toolUseId: String(p['itemId'] ?? ''),
          description: typeof p['reason'] === 'string' ? p['reason'] : null,
          mcpServer: null,
          // "Allow for this session" means Codex's own `acceptForSession`.
          suggestions: command
            ? [
                {
                  type: 'addRules',
                  rules: [{ toolName: 'Bash', ruleContent: command }],
                  behavior: 'allow',
                  destination: 'session',
                },
              ]
            : [],
        });
        if (result.behavior === 'deny') {
          return { decision: result.interrupt ? 'cancel' : 'decline' };
        }
        const updated = result.updatedInput?.['command'];
        if (
          result.ranByApp ||
          (typeof updated === 'string' && updated !== command)
        ) {
          // The app ran something itself instead (Autofix): Codex does not
          // run it and learns what came of it.
          this.tellOutcome(command, result.ranByApp ?? null);
          return { decision: 'decline' };
        }
        this.rememberRules(result);
        return {
          decision:
            (result.updatedPermissions?.length ?? 0) > 0
              ? 'acceptForSession'
              : 'accept',
        };
      }
      case 'item/fileChange/requestApproval': {
        const itemId = String(p['itemId'] ?? '');
        const changes = this.fileChanges.get(itemId) ?? [];
        const first = changes[0];
        const result = await this.options.approve({
          ...base,
          toolName: first?.kind.type === 'add' ? 'Write' : 'Edit',
          input: {
            file_path: first?.path ?? '',
            changes: changes.map((change) => ({
              path: change.path,
              kind: change.kind.type,
              diff: change.diff,
            })),
          },
          toolUseId: itemId,
          description: typeof p['reason'] === 'string' ? p['reason'] : null,
          mcpServer: null,
          suggestions: [],
        });
        if (result.behavior === 'deny') {
          return { decision: result.interrupt ? 'cancel' : 'decline' };
        }
        return { decision: 'accept' };
      }
      case 'item/tool/call':
        return this.appTool(p, signal);
      // Requests the app cannot put to the user: answered so that the turn
      // goes on without them, never left waiting.
      case 'item/tool/requestUserInput':
        this.logger.warn(
          `Codex asked the user questions (${method}); answered with none`,
        );
        return { answers: {} };
      case 'mcpServer/elicitation/request':
        this.logger.warn(`An MCP server asked for input (${method}); declined`);
        return { action: 'decline', content: null, _meta: null };
      case 'item/permissions/requestApproval':
        // Full access already: nothing more to grant.
        this.logger.warn(
          `Codex asked for further permissions (${method}); none granted`,
        );
        return { permissions: {}, scope: 'turn' };
      case 'applyPatchApproval':
      case 'execCommandApproval':
        // Requests of Codex's older API, not used with threads.
        this.logger.warn(`Codex sent ${method}; denied`);
        return {
          decision: { denied: { rejection: 'Not supported by this app.' } },
        };
      default:
        this.logger.warn(
          `Codex sent ${method}, which this app does not handle`,
        );
        throw new Error(`${method} is not supported by this app`);
    }
  }

  /** Bash rules the user just allowed for the session count from now on. */
  private rememberRules(result: AgentApprovalResult): void {
    if (result.behavior !== 'allow') {
      return;
    }
    for (const update of result.updatedPermissions ?? []) {
      if (update.type === 'addRules' && update.behavior === 'allow') {
        for (const rule of update.rules) {
          if (rule.toolName === 'Bash' && rule.ruleContent) {
            this.bashRules.push(`Bash(${rule.ruleContent})`);
          }
        }
      }
    }
  }

  /**
   * Tells the running turn what came of a command the app ran itself
   * instead of Codex (declined to Codex, which has no reason to give with
   * a decline): sent into the turn with `turn/steer` as a note of the app
   * (additional context) once the decline is answered; when the turn has
   * ended by then, with the next turn instead.
   */
  private tellOutcome(
    command: string,
    outcome: { ok: boolean; output: string } | null,
  ): void {
    const note = [
      `The session manager ran \`${command}\` itself instead of you (it runs git add, commit and push during Autofix), so it was declined to you; do not run it again.`,
      outcome
        ? `It ${outcome.ok ? 'succeeded' : 'failed'}. Output:\n${outcome.output}`
        : 'Its outcome is not known.',
    ].join('\n');
    setImmediate(() => {
      void this.steer(note);
    });
  }

  private async steer(note: string): Promise<void> {
    const turnId = this.turnId;
    if (!turnId || turnId === 'starting' || !this.server.running) {
      this.appNotes.push(note);
      return;
    }
    try {
      await this.server.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: turnId,
        clientUserMessageId: `${CODEX_APP_INPUT_PREFIX}${randomUUID()}`,
        input: [{ type: 'text', text: APP_INPUT_TEXT, text_elements: [] }],
        additionalContext: {
          crm_app_note: { kind: 'application', value: note },
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not tell Codex's turn what the app ran: ${String(error)}`,
      );
      this.appNotes.push(note);
    }
  }

  /** Notes the app could not send into their turn, for the next one. */
  private takeAppNotes(): Record<string, CodexContextEntry> {
    const notes = this.appNotes.splice(0);
    return notes.length > 0
      ? { crm_app_note: { kind: 'application', value: notes.join('\n\n') } }
      : {};
  }

  /** A call of one of the app's own tools (Codex's dynamic tools). */
  private async appTool(
    p: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const name = String(p['tool'] ?? '');
    const tool = this.options.tools?.find((entry) => entry.name === name);
    const fail = (text: string) => ({
      contentItems: [{ type: 'inputText', text }],
      success: false,
    });
    if (!tool) {
      return fail(
        `Unknown tool ${name}: this session manager does not offer it (any more).`,
      );
    }
    if (tool.unavailable) {
      // Registered for the thread, but not for this session now.
      return fail(tool.unavailable);
    }
    const input =
      typeof p['arguments'] === 'object' && p['arguments'] !== null
        ? (p['arguments'] as Record<string, unknown>)
        : {};
    const callId = String(p['callId'] ?? '');
    const fullName = codexToolName(CODEX_APP_TOOL_NAMESPACE, name);
    const gate = this.options.gate
      ? await this.options.gate({
          toolName: fullName,
          input,
          toolUseId: callId,
          agentId: null,
          mcpServer: { name: CODEX_APP_TOOL_NAMESPACE, source: 'sdk' },
        })
      : null;
    let approvedInput = input;
    if (gate?.decision === 'deny') {
      return fail(gate.reason);
    }
    const allowed =
      gate?.decision === 'allow' ||
      (gate?.decision !== 'ask' &&
        (this.options.allowedTools ?? []).includes(fullName));
    if (!allowed) {
      const result = await this.options.approve({
        toolName: fullName,
        input,
        toolUseId: callId,
        title: null,
        description: gate?.reason ?? null,
        displayName: null,
        decisionReason: null,
        blockedPath: null,
        agentId: null,
        mcpServer: { name: CODEX_APP_TOOL_NAMESPACE, source: 'sdk' },
        suggestions: [],
        suppressAlwaysAllow: false,
        signal,
      });
      if (result.behavior === 'deny') {
        return fail(result.message);
      }
      approvedInput = result.updatedInput ?? input;
    }
    try {
      const output = await tool.handler(approvedInput, { toolUseId: callId });
      return {
        contentItems: [{ type: 'inputText', text: output.text }],
        success: output.isError !== true,
      };
    } catch (error) {
      this.logger.warn(`App tool ${name} failed: ${String(error)}`);
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.turnId;
    if (!turnId) {
      return;
    }
    if (turnId === 'starting') {
      // Sent once Codex names the turn.
      this.interruptWanted = true;
      return;
    }
    await this.sendInterrupt(turnId);
  }

  private async sendInterrupt(turnId: string): Promise<void> {
    try {
      await this.server.request('turn/interrupt', {
        threadId: this.threadId,
        turnId,
      });
    } catch (error) {
      this.logger.warn(`Codex did not interrupt the turn: ${String(error)}`);
    }
  }

  async contextUsage() {
    const usage = this.translator.tokenUsage;
    const context = usage
      ? codexContextUsage(usage, this.translator.model)
      : null;
    if (!context) {
      throw new Error('Codex has not reported its context usage yet');
    }
    return context;
  }

  async planUsage() {
    return readPlanUsage(this.server);
  }

  async setPermissionMode(mode: SessionPermissionMode): Promise<void> {
    // From the next turn on.
    this.policy = codexPolicy(mode);
  }

  async setModel(model: string | null): Promise<void> {
    this.model = model;
    if (model) {
      this.translator.model = model;
    }
  }

  async supportedCommands() {
    return [];
  }

  async stopTask(): Promise<void> {
    // Codex has no background tasks the app can stop.
  }

  async addDirectories(): Promise<void> {
    // Full access: Codex can work in any directory already.
  }

  close(): void {
    this.closed = true;
    for (const controller of this.openRequests.values()) {
      controller.abort();
    }
    this.server?.close();
    this.queue.close();
  }

  stderrTail(): string[] {
    return this.server?.stderrTail() ?? [];
  }
}

/** The app's tools as Codex dynamic tools (JSON schema from Zod). */
async function dynamicTools(tools: AgentTool[] | undefined) {
  if (!tools || tools.length === 0) {
    return [];
  }
  const z = await loadZod();
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.object(tool.inputSchema(z))),
  }));
}

/** The machine's rules for sessions, read for every process; `null`: none. */
async function machineInstructions(
  file: string | null,
): Promise<string | null> {
  if (!file) {
    return null;
  }
  try {
    return (await readFile(file, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}
