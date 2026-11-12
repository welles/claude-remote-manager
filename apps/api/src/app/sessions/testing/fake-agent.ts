import type {
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRun,
  AgentRunner,
  AgentStartOptions,
  AgentUserMessage,
} from '../../agent/agent-runner';
import { AsyncQueue } from '../../agent/async-queue';
import type { TranscriptReader } from '../../agent/transcript-reader';

/** A Claude Code process whose messages the test pushes. */
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

  constructor(
    readonly options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ) {
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

  async contextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return this.context as SDKControlGetContextUsageResponse;
  }

  async planUsage(): Promise<SDKControlGetUsageResponse> {
    throw new Error('not available in tests');
  }

  close(): void {
    this.closed = true;
    this.output.close();
  }
}

export class FakeAgentRunner implements AgentRunner {
  readonly runs: FakeRun[] = [];
  failNextStart: Error | null = null;

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

export class FakeTranscriptReader implements TranscriptReader {
  transcripts = new Map<string, SessionMessage[]>();
  reads: { sdkSessionId: string; cwd: string }[] = [];

  async read(sdkSessionId: string, cwd: string): Promise<SessionMessage[]> {
    this.reads.push({ sdkSessionId, cwd });
    return this.transcripts.get(sdkSessionId) ?? [];
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
