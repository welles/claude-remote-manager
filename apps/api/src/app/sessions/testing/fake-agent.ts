import type {
  CanUseTool,
  ModelInfo,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentReviewOptions,
  AgentReviewResult,
  AgentProbe,
  AgentRun,
  AgentRunner,
  AgentStartOptions,
  AgentUserMessage,
} from '../../agent/agent-runner';
import { AsyncQueue } from '../../agent/async-queue';
import type {
  AgentCommand,
  AgentContextUsage,
  AgentEvent,
  AgentHistoryEntry,
  AgentModel,
  AgentPlanUsage,
} from '../../agent/agent-events';
import {
  ClaudeEventTranslator,
  claudeCanUseTool,
  claudeHistory,
  claudeCommand,
  claudeContextUsage,
  claudeModel,
  claudePlanUsage,
} from '../../agent/claude-events';
import { translateMessages } from '../../agent/sdk-agent-runner';
import type { TranscriptReader } from '../../agent/transcript-reader';
import type { SessionPermissionMode } from '@claude-remote-manager/shared-types';

/**
 * A Claude Code process whose messages the test pushes; they reach the
 * session through the Claude Code adapter's translation, as in production.
 */
export class FakeRun implements AgentRun {
  readonly output = new AsyncQueue<SDKMessage>();
  readonly sent: AgentUserMessage[] = [];
  interrupted = 0;
  closed = false;
  context: Partial<SDKControlGetContextUsageResponse> = {
    model: 'claude-haiku',
    totalTokens: 1200,
    maxTokens: 200_000,
    percentage: 0.6,
  };

  /**
   * What the process was started with; `canUseTool` is the approver as
   * Claude Code calls it (through the adapter), for tests to ask with.
   */
  readonly options: AgentStartOptions & { canUseTool: CanUseTool };

  constructor(options: AgentStartOptions, firstMessage: AgentUserMessage) {
    this.options = { ...options, canUseTool: claudeCanUseTool(options.approve) };
    this.sent.push(firstMessage);
  }

  emit(...messages: Record<string, unknown>[]): void {
    for (const message of messages) {
      this.output.push({
        uuid: 'u',
        session_id: 'sdk-1',
        ...message,
      } as unknown as SDKMessage);
    }
  }

  /** Ends the process like a crash. */
  crash(error: Error): void {
    this.failure = error;
    this.output.close();
  }

  private failure: Error | null = null;

  private readonly translator = new ClaudeEventTranslator();

  /** The pushed messages as agent events. */
  get events(): AsyncIterable<AgentEvent> {
    return translateMessages(this.messages, this.translator);
  }

  /** The pushed messages; iteration throws after `crash`. */
  get messages(): AsyncIterable<SDKMessage> {
    return {
      [Symbol.asyncIterator]: () => {
        const inner = this.output[Symbol.asyncIterator]();
        return {
          next: async () => {
            const result = await inner.next();
            if (result.done && this.failure) {
              throw this.failure;
            }
            return result;
          },
        };
      },
    };
  }

  send(message: AgentUserMessage): void {
    this.sent.push(message);
  }

  async interrupt(): Promise<void> {
    this.interrupted++;
  }

  async contextUsage(): Promise<AgentContextUsage> {
    return claudeContextUsage(
      this.context as SDKControlGetContextUsageResponse,
    );
  }

  async planUsage(): Promise<AgentPlanUsage> {
    throw new Error('not available in tests');
  }

  /** Mode and model switches of the running process, in order. */
  readonly switches: (
    | { permissionMode: SessionPermissionMode }
    | { model: string | null }
  )[] = [];
  /** Set to make the next switch fail. */
  failSwitch: Error | null = null;

  async setPermissionMode(mode: SessionPermissionMode): Promise<void> {
    this.takeFailure();
    this.switches.push({ permissionMode: mode });
  }

  async setModel(model: string | null): Promise<void> {
    this.takeFailure();
    this.switches.push({ model });
  }

  /** What `supportedCommands` answers. */
  commands: SlashCommand[] = [];

  async supportedCommands(): Promise<AgentCommand[]> {
    return this.commands.map(claudeCommand);
  }

  /** Tasks the app stopped. */
  readonly stoppedTasks: string[] = [];

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
  }

  /** Directories added to the running process, in order. */
  readonly addedDirectories: string[] = [];
  /** Set to make adding directories fail (a Claude Code that cannot). */
  failAddDirectories: Error | null = null;

  async addDirectories(directories: string[]): Promise<void> {
    if (this.failAddDirectories) {
      throw this.failAddDirectories;
    }
    this.addedDirectories.push(...directories);
  }

  private takeFailure(): void {
    const failure = this.failSwitch;
    this.failSwitch = null;
    if (failure) {
      throw failure;
    }
  }

  close(): void {
    this.closed = true;
    this.output.close();
  }

  stderr: string[] = [];

  stderrTail(): string[] {
    return this.stderr;
  }
}

export class FakeAgentRunner implements AgentRunner {
  readonly runs: FakeRun[] = [];
  failNextStart: Error | null = null;
  /** What probe processes answer; a function may throw. */
  probeModels: () => ModelInfo[] = () => [];
  probeUsage: () => SDKControlGetUsageResponse = () => {
    throw new Error('not available in tests');
  };
  probeCommands: () => SlashCommand[] = () => [];
  probes = 0;
  /** Review processes started, in order. */
  readonly reviews: FakeReview[] = [];

  review(options: AgentReviewOptions): Promise<AgentReviewResult> {
    const review = new FakeReview(options);
    this.reviews.push(review);
    return review.result;
  }

  async probe<T>(task: (probe: AgentProbe) => Promise<T>): Promise<T> {
    this.probes++;
    return task({
      supportedModels: async (): Promise<AgentModel[]> =>
        this.probeModels().map(claudeModel),
      planUsage: async () => claudePlanUsage(this.probeUsage()),
      supportedCommands: async () => this.probeCommands().map(claudeCommand),
    });
  }

  async start(
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<AgentRun> {
    if (this.failNextStart) {
      const error = this.failNextStart;
      this.failNextStart = null;
      throw error;
    }
    const run = new FakeRun(options, firstMessage);
    this.runs.push(run);
    return run;
  }

  get last(): FakeRun {
    const run = this.runs.at(-1);
    if (!run) {
      throw new Error('No run started');
    }
    return run;
  }
}

/** A review process of a test: it ends when the test says so. */
export class FakeReview {
  readonly result: Promise<AgentReviewResult>;
  finish!: (result: Partial<AgentReviewResult>) => void;
  fail!: (error: Error) => void;

  constructor(readonly options: AgentReviewOptions) {
    this.result = new Promise<AgentReviewResult>((resolve, reject) => {
      this.finish = (result) =>
        resolve({
          output: null,
          error: null,
          modelUsage: {},
          durationMs: 1000,
          ...result,
        });
      this.fail = reject;
      options.signal.addEventListener('abort', () =>
        reject(new Error('aborted')),
      );
    });
    // A test that never ends the review leaves no unhandled rejection.
    this.result.catch(() => undefined);
  }
}

export class FakeTranscriptReader implements TranscriptReader {
  transcripts = new Map<string, SessionMessage[]>();
  reads: { sdkSessionId: string; cwd: string }[] = [];

  /** Session IDs that have a transcript besides those in `transcripts`. */
  existing = new Set<string>();

  async exists(sdkSessionId: string): Promise<boolean> {
    return (
      this.existing.has(sdkSessionId) || this.transcripts.has(sdkSessionId)
    );
  }

  /** Changes the stamp of every transcript (as if they were written). */
  version = 1;

  async stamp(sdkSessionId: string): Promise<string | null> {
    return (await this.exists(sdkSessionId))
      ? `${this.transcripts.get(sdkSessionId)?.length ?? 0}@${this.version}`
      : null;
  }

  /** Makes `read` fail, like an unreadable transcript. */
  failing = false;

  async read(
    sdkSessionId: string,
    cwd: string,
  ): Promise<AgentHistoryEntry[]> {
    this.reads.push({ sdkSessionId, cwd });
    if (this.failing) {
      throw new Error('transcript unreadable');
    }
    return claudeHistory(this.transcripts.get(sdkSessionId) ?? []);
  }
}

/** A result message with cumulative usage of one model. */
export function resultMessage(
  inputTokens: number,
  costUsd: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    duration_ms: 1500,
    duration_api_ms: 1200,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: costUsd,
    usage: {},
    modelUsage: {
      'claude-haiku': {
        inputTokens,
        outputTokens: inputTokens * 2,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 0,
        costUSD: costUsd,
        webSearchRequests: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    permission_denials: [],
    ...extra,
  };
}

/** Lets pending promises and async iteration steps run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Polls until the condition holds (for work that runs real processes). */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
