import { Injectable, Logger } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
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
import type { AgentEvent, AgentHistoryEntry } from '../agent-events';
import { AsyncQueue } from '../async-queue';
import { loadZod } from '../sdk-agent-runner';
import type { TranscriptReader } from '../transcript-reader';
import { CodexAppServer } from './codex-app-server';
import {
  CODEX_APP_TOOL_NAMESPACE,
  CodexEventTranslator,
  codexContextUsage,
  codexHistory,
  codexModel,
  codexPlanUsage,
  codexToolName,
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

/** The text and image inputs of a message (context and note first). */
export function codexInput(message: AgentUserMessage): CodexUserInput[] {
  const text = (value: string): CodexUserInput => ({
    type: 'text',
    text: value,
    text_elements: [],
  });
  return [
    ...(message.context ? [text(message.context.text)] : []),
    ...(message.note ? [text(message.note.text)] : []),
    ...(message.images ?? []).map(
      (image): CodexUserInput => ({
        type: 'image',
        url: `data:${image.mediaType};base64,${image.data}`,
      }),
    ),
    ...(message.text ? [text(message.text)] : []),
  ];
}

/**
 * The rollout file of a thread under a Codex home's `sessions/` (shared by
 * all accounts): Codex resumes a thread of another account by its path.
 */
export async function findRollout(
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

/** Where the runner finds Codex. */
export interface CodexRunnerConfig {
  executable: string;
  /** The Codex home whose `sessions/` all accounts share (history reads). */
  baseHome: string;
}

/**
 * Starts Codex processes (`codex app-server`) for sessions, one thread per
 * session, as the session user with the account's Codex home: the Codex
 * adapter of the engine-neutral core.
 */
@Injectable()
export class CodexRunner implements AgentRunner {
  private readonly logger = new Logger(CodexRunner.name);

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
          const answer = await server.request<{ data: CodexModel[] }>(
            'model/list',
            {},
          );
          return answer.data.filter((model) => !model.hidden).map(codexModel);
        },
        supportedCommands: async () => [],
        planUsage: async () => {
          const answer = await server.request<{
            rateLimits: CodexRateLimitSnapshot;
          }>('account/rateLimits/read', {});
          return codexPlanUsage(answer.rateLimits);
        },
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

  /** Reads a thread's history (any account's, through the shared rollouts). */
  async history(threadId: string, cwd: string): Promise<AgentHistoryEntry[]> {
    const path = await findRollout(this.config.baseHome, threadId);
    if (!path) {
      return [];
    }
    const server = await CodexAppServer.start({
      executable: this.config.executable,
      launcher: this.launcher,
      home: this.config.baseHome,
      cwd,
    });
    try {
      await server.request('thread/resume', { threadId, path, cwd });
      const answer = await server.request<{
        thread: { turns?: CodexTurn[] };
      }>('thread/read', { threadId, includeTurns: true });
      return codexHistory(answer.thread.turns ?? []);
    } finally {
      server.close();
    }
  }
}

/** Codex's history reader (see `TranscriptReader`). */
export class CodexTranscriptReader implements TranscriptReader {
  constructor(
    private readonly runner: CodexRunner,
    private readonly baseHome: string,
  ) {}

  read(threadId: string, cwd: string): Promise<AgentHistoryEntry[]> {
    return this.runner.history(threadId, cwd);
  }

  async exists(threadId: string): Promise<boolean> {
    return (await findRollout(this.baseHome, threadId)) !== null;
  }

  async stamp(threadId: string): Promise<string | null> {
    const path = await findRollout(this.baseHome, threadId);
    if (!path) {
      return null;
    }
    const { stat } = await import('node:fs/promises');
    const info = await stat(path);
    return `${info.size}@${info.mtimeMs}`;
  }
}

/** One running Codex process with its thread. */
class CodexProcess implements AgentRun {
  private readonly queue = new AsyncQueue<AgentEvent[]>();
  private readonly pending: AgentUserMessage[] = [];
  private readonly fileChanges = new Map<string, CodexFileUpdateChange[]>();
  private server!: CodexAppServer;
  private translator!: CodexEventTranslator;
  private threadId = '';
  private turnId: string | null = null;
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
  }

  static async start(
    config: CodexRunnerConfig,
    launcher: ProcessLauncher,
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<CodexProcess> {
    const run = new CodexProcess(config, launcher, options);
    await run.open();
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
      onRequest: (method, params) => this.serverRequest(method, params),
      onExit: (error) => {
        if (error && !this.closed) {
          this.queue.fail(error);
        } else {
          this.queue.close();
        }
      },
    });
    const common = {
      cwd: this.options.cwd,
      // Full access, as Claude Code has; asking is the approval policy's.
      sandbox: 'danger-full-access',
      approvalPolicy: this.policy,
      ...(this.model ? { model: this.model } : {}),
      ...(this.options.instructions
        ? { developerInstructions: this.options.instructions }
        : {}),
    };
    let started: CodexThreadStartResponse;
    if (this.options.resume) {
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
    );
    this.emit([
      {
        type: 'started',
        engineSessionId: this.threadId,
        permissionMode: null,
        terminalCommands: [],
      },
    ]);
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
    this.turnId = 'starting';
    this.server
      .request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId,
        clientUserMessageId: message.id,
        input: codexInput(message),
        approvalPolicy: this.policy,
        ...(this.model ? { model: this.model } : {}),
      })
      .then((answer) => {
        if (this.turnId === 'starting') {
          this.turnId = answer.turn.id;
        }
      })
      .catch((error: unknown) => {
        this.turnId = null;
        this.emit([
          {
            type: 'output',
            events: [
              {
                type: 'error',
                message: `Codex did not start the turn: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            anchor: null,
            images: [],
            contextChanged: false,
          },
          this.failedResult(),
        ]);
      });
  }

  private failedResult(): AgentEvent {
    return {
      type: 'result',
      subtype: 'success',
      isError: true,
      text: 'The turn could not start.',
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
      return;
    }
    if (method === 'item/started') {
      const item = (params as { item?: CodexThreadItem }).item;
      if (item?.type === 'fileChange') {
        // Kept for the approval of the change.
        this.fileChanges.set(
          item.id,
          (item as { changes: CodexFileUpdateChange[] }).changes,
        );
      }
    }
    if (method === 'turn/started') {
      this.turnId = (params as { turn: { id: string } }).turn.id;
    }
    const events = this.translator.translate(method, params);
    if (method === 'turn/completed') {
      this.turnId = null;
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
  ): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const signal = new AbortController().signal;
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
        const command = typeof p['command'] === 'string' ? p['command'] : '';
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
        if (typeof updated === 'string' && updated !== command) {
          // The app ran something itself instead (autofix): not Codex.
          return { decision: 'decline' };
        }
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
        return this.appTool(p);
      default:
        // Nothing else is asked with full access; refused if it is.
        throw new Error(`${method} is not supported by this app`);
    }
  }

  /** A call of one of the app's own tools (Codex's dynamic tools). */
  private async appTool(p: Record<string, unknown>): Promise<unknown> {
    const name = String(p['tool'] ?? '');
    const tool = this.options.tools?.find((entry) => entry.name === name);
    const fail = (text: string) => ({
      contentItems: [{ type: 'inputText', text }],
      success: false,
    });
    if (!tool) {
      return fail(`Unknown tool ${name}`);
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
        signal: new AbortController().signal,
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
      this.logger().warn(`App tool ${name} failed: ${String(error)}`);
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private logger(): Logger {
    return new Logger('CodexProcess');
  }

  async interrupt(): Promise<void> {
    const turnId = this.turnId;
    if (!turnId || turnId === 'starting') {
      return;
    }
    await this.server.request('turn/interrupt', {
      threadId: this.threadId,
      turnId,
    });
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
    const answer = await this.server.request<{
      rateLimits: CodexRateLimitSnapshot;
    }>('account/rateLimits/read', {});
    return codexPlanUsage(answer.rateLimits);
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
