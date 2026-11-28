import {
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  renameSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { SessionEventInput } from '@claude-remote-manager/shared-types';
import { SINGLE_USER } from '../../common/process-isolation';
import type {
  AgentApprovalCall,
  AgentApprovalResult,
  AgentEvent,
} from '../agent-events';
import type {
  AgentReviewOptions,
  AgentRun,
  AgentStartOptions,
  AgentTool,
  AgentUserMessage,
} from '../agent-runner';
import {
  CodexRunner,
  CodexTranscriptReader,
  codexAdditionalContext,
  codexInput,
  codexPolicy,
  codexReviewEffort,
  findRollout,
  matchesBashRule,
} from './codex-runner';
import { AgentReviewRefused } from '../agent-runner';
import { codexRulesReason } from './review-commands';
import {
  fakeCodexPids,
  fakeCodexRequests,
  processEnded,
  writeFakeCodex,
} from './testing/fake-codex';

// The ES module Zod needs a VM flag in Jest; its CommonJS build is the same.
jest.mock('../sdk-agent-runner', () => ({
  loadZod: () => Promise.resolve(jest.requireActual('zod')),
}));

jest.setTimeout(20_000);

type Result = Extract<AgentEvent, { type: 'result' }>;

/** Reads a run's events batch by batch. */
class EventReader {
  private readonly iterator: AsyncIterator<AgentEvent[]>;
  /** Everything read so far. */
  readonly all: AgentEvent[] = [];

  constructor(run: AgentRun) {
    this.iterator = run.events[Symbol.asyncIterator]();
  }

  /** Reads until an event matches; returns the events read meanwhile. */
  async until(
    match: (event: AgentEvent) => boolean,
    timeoutMs = 10_000,
  ): Promise<AgentEvent[]> {
    const read: AgentEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const next = await Promise.race([
        this.iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('No matching event in time')),
            Math.max(0, deadline - Date.now()),
          ).unref(),
        ),
      ]);
      if (next.done) {
        throw new Error('The events ended');
      }
      read.push(...next.value);
      this.all.push(...next.value);
      if (next.value.some(match)) {
        return read;
      }
    }
  }

  /** Reads until the next turn result and returns it with what came before. */
  async result(): Promise<{ result: Result; events: AgentEvent[] }> {
    const events = await this.until((event) => event.type === 'result');
    return {
      result: events.find((event) => event.type === 'result') as Result,
      events,
    };
  }

  /** The end of the events (`null`) or the error they end with. */
  async end(): Promise<Error | null> {
    try {
      for (;;) {
        const next = await this.iterator.next();
        if (next.done) {
          return null;
        }
        this.all.push(...next.value);
      }
    } catch (error) {
      return error as Error;
    }
  }
}

const logOf = (events: AgentEvent[]): SessionEventInput[] =>
  events.flatMap((event) => (event.type === 'output' ? event.events : []));

const texts = (events: AgentEvent[]) =>
  logOf(events)
    .filter((event) => event.type === 'assistant.text')
    .map((event) => (event as { text: string }).text);

let counter = 0;
const message = (text: string): AgentUserMessage => ({
  id: `client-${++counter}`,
  text,
});

describe('CodexRunner', () => {
  let dir: string;
  let home: string;
  let cwd: string;
  let runner: CodexRunner;
  let runs: AgentRun[];
  let approve: jest.Mock<Promise<AgentApprovalResult>, [AgentApprovalCall]>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-codex-runner-'));
    home = join(dir, 'codex-home');
    cwd = join(dir, 'work');
    mkdirSync(home);
    mkdirSync(cwd);
    runner = new CodexRunner(
      { executable: writeFakeCodex(dir), baseHome: home },
      SINGLE_USER,
    );
    runs = [];
    approve = jest.fn<Promise<AgentApprovalResult>, [AgentApprovalCall]>(
      async () => ({ behavior: 'allow' }),
    );
  });
  afterEach(() => {
    for (const run of runs) {
      run.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (
    overrides: Partial<AgentStartOptions> = {},
  ): AgentStartOptions => ({
    cwd,
    additionalDirectories: [],
    model: null,
    permissionMode: 'untrusted',
    resume: null,
    sessionId: null,
    approve,
    ...overrides,
  });

  const start = async (
    first: AgentUserMessage,
    overrides: Partial<AgentStartOptions> = {},
  ) => {
    const run = await runner.start(options(overrides), first);
    runs.push(run);
    return { run, events: new EventReader(run) };
  };

  const requests = (method: string, at = home) =>
    fakeCodexRequests(at)
      .filter((request) => request.method === method)
      .map((request) => request.params ?? {});

  it('probes the models and the plan usage with the account’s home', async () => {
    const account = join(dir, 'account');
    mkdirSync(account);
    const answer = await runner.probe(
      async (probe) => ({
        models: await probe.supportedModels(),
        usage: await probe.planUsage(),
        commands: await probe.supportedCommands(),
      }),
      { configDir: account, main: false },
    );
    expect(answer.models).toEqual([
      {
        value: null,
        label: 'GPT-5.5 Codex',
        description: 'GPT-5.5 Codex model',
        resolvedModel: 'gpt-5.5-codex',
      },
      {
        value: 'gpt-5.4',
        label: 'GPT-5.4',
        description: 'GPT-5.4 model',
        resolvedModel: 'gpt-5.4',
      },
    ]);
    expect(answer.usage).toEqual({
      subscriptionType: 'plus',
      windows: [
        expect.objectContaining({ window: 'five_hour', utilization: 25 }),
        expect.objectContaining({ window: 'seven_day', utilization: 60 }),
      ],
    });
    expect(answer.commands).toEqual([]);
    expect(fakeCodexRequests(account).map((r) => r.method)).toEqual([
      'initialize',
      'initialized',
      // Both pages.
      'model/list',
      'model/list',
      'account/rateLimits/read',
    ]);
    expect(fakeCodexRequests(home)).toEqual([]);
  });

  it('starts a thread, runs the first message and reports its events', async () => {
    const { run, events } = await start(message('hello there'), {
      instructions: 'Be brief.',
      env: { SESSION_VAR: '1' },
    });
    const { result, events: turn } = await events.result();
    const started = events.all[0];
    expect(started).toEqual({
      type: 'started',
      engineSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      permissionMode: null,
      terminalCommands: [],
    });
    const threadId = (started as { engineSessionId: string }).engineSessionId;

    expect(turn).toContainEqual({ type: 'activity' });
    expect(logOf(turn).filter((e) => e.type === 'assistant.delta')).toEqual([
      expect.objectContaining({ text: 'Echo: hel' }),
      expect.objectContaining({ text: 'lo there' }),
    ]);
    expect(texts(turn)).toEqual(['Echo: hello there']);
    // The user's message anchors what follows.
    expect(turn).toContainEqual(
      expect.objectContaining({ type: 'output', anchor: `client-${counter}` }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        isError: false,
        text: null,
        engineSessionId: threadId,
        queuedTurns: 0,
        usage: {
          'gpt-5.5-codex': expect.objectContaining({ outputTokens: 200 }),
        },
      }),
    );
    // Only the plan's main bucket, merged with sparse updates.
    expect(
      turn
        .filter((event) => event.type === 'rate-limit')
        .map((event) => (event as { limit: unknown }).limit),
    ).toEqual([
      expect.objectContaining({ window: 'five_hour', utilization: 25 }),
      expect.objectContaining({ window: 'seven_day', utilization: 60 }),
      expect.objectContaining({ window: 'five_hour', utilization: 30 }),
      expect.objectContaining({ window: 'seven_day', utilization: 60 }),
    ]);

    expect(requests('thread/start')).toEqual([
      {
        cwd,
        sandbox: 'danger-full-access',
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        config: { project_doc_fallback_filenames: ['CLAUDE.md'] },
        developerInstructions: 'Be brief.',
        dynamicTools: [],
      },
    ]);
    expect(requests('turn/start')).toEqual([
      {
        threadId,
        clientUserMessageId: `client-${counter}`,
        input: [{ type: 'text', text: 'hello there', text_elements: [] }],
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
      },
    ]);

    expect(await run.contextUsage()).toEqual({
      model: 'gpt-5.5-codex',
      usedTokens: 1000,
      maxTokens: 200000,
      percentage: 0.5,
    });
    expect(await run.planUsage()).toEqual(
      expect.objectContaining({ subscriptionType: 'plus' }),
    );
    expect(await run.supportedCommands()).toEqual([]);
    expect(run.stderrTail()).toEqual(['fake codex app-server ready']);
    expect(await findRollout(home, threadId)).toMatch(
      new RegExp(
        `/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-.*-${threadId}\\.jsonl$`,
      ),
    );
  });

  it('has no context usage before Codex reported it', async () => {
    const { run, events } = await start(message('slow'));
    await events.until((event) => event.type === 'started');
    await expect(run.contextUsage()).rejects.toThrow(/not reported/);
  });

  it('asks for a command’s approval and answers with Codex’s decisions', async () => {
    const { run, events } = await start(message('run-command'));
    let turn = await events.result();
    expect(approve).toHaveBeenCalledTimes(1);
    const call = approve.mock.calls[0][0];
    expect(call).toEqual(
      expect.objectContaining({
        toolName: 'Bash',
        // The script, not the shell Codex wraps it in.
        input: { command: "echo 'hi'", cwd },
        toolUseId: expect.stringMatching(/^cmd-/),
        description: 'Wants to say hi',
        mcpServer: null,
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: "echo 'hi'" }],
            behavior: 'allow',
            destination: 'session',
          },
        ],
      }),
    );
    expect(logOf(turn.events)).toContainEqual(
      expect.objectContaining({
        type: 'tool.call',
        name: 'Bash',
        input: { command: "echo 'hi'", cwd },
      }),
    );
    expect(texts(turn.events)).toEqual(['decision: accept']);
    expect(logOf(turn.events)).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        toolUseId: call.toolUseId,
        isError: false,
        content: 'hi\n',
      }),
    );

    const answers: [AgentApprovalResult, string][] = [
      [{ behavior: 'deny', message: 'no' }, 'decision: decline'],
      [
        { behavior: 'allow', updatedInput: { command: 'echo other' } },
        'decision: decline',
      ],
      // Allowed for the session: the next one is not asked any more.
      [
        {
          behavior: 'allow',
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: "echo 'hi'" }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        },
        'decision: acceptForSession',
      ],
    ];
    for (const [answer, text] of answers) {
      approve.mockResolvedValueOnce(answer);
      run.send(message('run-command'));
      turn = await events.result();
      expect(texts(turn.events)).toEqual([text]);
    }

    approve.mockClear();
    run.send(message('run-command'));
    turn = await events.result();
    expect(approve).not.toHaveBeenCalled();
    expect(texts(turn.events)).toEqual(['decision: accept']);

    // Denied with interrupt: Codex cancels the turn.
    approve.mockResolvedValueOnce({
      behavior: 'deny',
      message: 'stop',
      interrupt: true,
    });
    run.send(message('git-push'));
    turn = await events.result();
    expect(texts(turn.events)).toEqual([]);
    expect(turn.result.isError).toBe(false);
    expect(logOf(turn.events)).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        isError: true,
        content: 'Declined',
      }),
    );
  });

  it('asks for a file change’s approval with its changes', async () => {
    const { events } = await start(message('edit-file'));
    const turn = await events.result();
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Edit',
        toolUseId: expect.stringMatching(/^patch-/),
        input: {
          file_path: join(cwd, 'notes.txt'),
          changes: [
            {
              path: join(cwd, 'notes.txt'),
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old\n+new\n',
            },
          ],
        },
      }),
    );
    expect(texts(turn.events)).toEqual(['decision: accept']);
    expect(logOf(turn.events)).toContainEqual(
      expect.objectContaining({
        type: 'tool.diff',
        diff: expect.objectContaining({ additions: 1, deletions: 1 }),
      }),
    );
  });

  describe('the app’s own tools', () => {
    const handler = jest.fn(async (input: Record<string, unknown>) => ({
      text: `got ${JSON.stringify(input)}`,
    }));
    const tool: AgentTool = {
      name: 'echo_tool',
      description: 'Echoes',
      inputSchema: (z) => ({ value: z.number() }),
      handler,
    };
    beforeEach(() => handler.mockClear());

    it('offers them as dynamic tools and runs allowed ones without asking', async () => {
      const { events } = await start(message('app-tool:echo_tool'), {
        tools: [tool],
        allowedTools: ['mcp__crm__echo_tool'],
      });
      const turn = await events.result();
      expect(requests('thread/start')[0]['dynamicTools']).toEqual([
        {
          type: 'function',
          name: 'echo_tool',
          description: 'Echoes',
          inputSchema: expect.objectContaining({
            type: 'object',
            properties: { value: expect.objectContaining({ type: 'number' }) },
          }),
        },
      ]);
      expect(approve).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(
        { value: 42 },
        { toolUseId: expect.stringMatching(/^call-/) },
      );
      expect(texts(turn.events)).toEqual(['tool said: got {"value":42}']);
      expect(logOf(turn.events)).toContainEqual(
        expect.objectContaining({
          type: 'tool.call',
          name: 'mcp__crm__echo_tool',
          input: { value: 42 },
        }),
      );
    });

    it('asks for the others, and runs them with the approved input', async () => {
      approve.mockResolvedValueOnce({
        behavior: 'allow',
        updatedInput: { value: 7 },
      });
      const { run, events } = await start(message('app-tool:echo_tool'), {
        tools: [tool],
      });
      let turn = await events.result();
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'mcp__crm__echo_tool',
          input: { value: 42 },
          mcpServer: { name: 'crm', source: 'sdk' },
        }),
      );
      expect(texts(turn.events)).toEqual(['tool said: got {"value":7}']);

      approve.mockResolvedValueOnce({ behavior: 'deny', message: 'Not now' });
      run.send(message('app-tool:echo_tool'));
      turn = await events.result();
      expect(texts(turn.events)).toEqual(['tool said: Not now']);
      expect(logOf(turn.events)).toContainEqual(
        expect.objectContaining({ type: 'tool.result', isError: true }),
      );

      run.send(message('app-tool:missing'));
      turn = await events.result();
      expect(texts(turn.events)).toEqual([
        'tool said: Unknown tool missing: this session manager does not offer it (any more).',
      ]);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('follows the gate, and reports a failing handler', async () => {
      const gate = jest
        .fn()
        .mockResolvedValueOnce({ decision: 'deny', reason: 'Automerge is off' })
        .mockResolvedValueOnce({ decision: 'ask', reason: 'Really?' })
        .mockResolvedValueOnce({ decision: 'allow', reason: '' });
      handler.mockRejectedValueOnce(new Error('exploded'));
      const { run, events } = await start(message('app-tool:echo_tool'), {
        tools: [tool],
        allowedTools: ['mcp__crm__echo_tool'],
        gate,
      });
      let turn = await events.result();
      expect(gate).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'mcp__crm__echo_tool',
          input: { value: 42 },
          mcpServer: { name: 'crm', source: 'sdk' },
        }),
      );
      expect(texts(turn.events)).toEqual(['tool said: Automerge is off']);
      expect(handler).not.toHaveBeenCalled();

      // `ask` asks although the tool is allowed; the handler fails.
      run.send(message('app-tool:echo_tool'));
      turn = await events.result();
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Really?' }),
      );
      expect(texts(turn.events)).toEqual(['tool said: exploded']);

      approve.mockClear();
      run.send(message('app-tool:echo_tool'));
      turn = await events.result();
      expect(approve).not.toHaveBeenCalled();
      expect(texts(turn.events)).toEqual(['tool said: got {"value":42}']);
    });
  });

  it('queues a message behind the running turn', async () => {
    const { run, events } = await start(message('first'));
    run.send(message('second'));
    run.send(message('third'));
    const first = await events.result();
    expect(texts(first.events)).toEqual(['Echo: first']);
    expect(first.result.queuedTurns).toBe(2);
    const second = await events.result();
    expect(texts(second.events)).toEqual(['Echo: second']);
    expect(second.result.queuedTurns).toBe(1);
    const third = await events.result();
    expect(texts(third.events)).toEqual(['Echo: third']);
    expect(third.result.queuedTurns).toBe(0);
    expect(requests('turn/start')).toHaveLength(3);
  });

  it('keeps a subagent’s turns apart from the thread’s own', async () => {
    const { run, events } = await start(message('subagent run-command'));
    run.send(message('after'));
    // The subagent's turn ends while the approval is open: the queued
    // message must wait for the thread's own turn.
    const first = await events.result();
    expect(texts(first.events)).toEqual(['decision: accept']);
    expect(first.result.queuedTurns).toBe(1);
    const second = await events.result();
    expect(texts(second.events)).toEqual(['Echo: after']);
    expect(logOf(events.all).filter((e) => e.type === 'error')).toEqual([]);
  });

  it('interrupts the running turn', async () => {
    const { run, events } = await start(message('slow'));
    // The user's message completes once the turn has started.
    await events.until(
      (event) =>
        event.type === 'output' && event.anchor === `client-${counter}`,
    );
    await run.interrupt();
    const { result } = await events.result();
    expect(result.isError).toBe(false);
    const [interrupt] = requests('turn/interrupt');
    expect(interrupt).toEqual({
      threadId: (events.all[0] as { engineSessionId: string }).engineSessionId,
      turnId: expect.stringMatching(/^turn-/),
    });
    // Nothing runs: nothing to interrupt.
    await run.interrupt();
    expect(requests('turn/interrupt')).toHaveLength(1);
  });

  it('reports the usage limit', async () => {
    const { events } = await start(message('limit'));
    const { result, events: turn } = await events.result();
    expect(turn).toContainEqual({ type: 'limit-hit' });
    expect(result).toEqual(
      expect.objectContaining({
        isError: true,
        text: "You've hit your usage limit.",
      }),
    );
  });

  it('reports a turn Codex refuses to start, and goes on', async () => {
    const { run, events } = await start(message('fail-start'));
    const { result, events: turn } = await events.result();
    // One error: the result's text.
    expect(logOf(turn)).toEqual([]);
    expect(result).toEqual(
      expect.objectContaining({
        isError: true,
        text: 'Codex did not start the turn: turn refused',
      }),
    );
    run.send(message('again'));
    expect(texts((await events.result()).events)).toEqual(['Echo: again']);
  });

  it('switches model and approval policy for the next turn', async () => {
    const { run, events } = await start(message('one'), {
      model: 'gpt-5.4',
      permissionMode: 'on-request',
    });
    await events.result();
    await run.setModel('gpt-5.5-codex');
    await run.setPermissionMode('never');
    run.send(message('two'));
    const { result } = await events.result();
    expect(requests('thread/start')[0]).toEqual(
      expect.objectContaining({
        model: 'gpt-5.4',
        approvalPolicy: 'on-request',
      }),
    );
    expect(requests('turn/start')).toEqual([
      expect.objectContaining({
        model: 'gpt-5.4',
        approvalPolicy: 'on-request',
      }),
      expect.objectContaining({
        model: 'gpt-5.5-codex',
        approvalPolicy: 'never',
      }),
    ]);
    // Each turn's usage counts for its model, cumulative per model.
    expect(result.usage).toEqual({
      'gpt-5.4': expect.objectContaining({ outputTokens: 200 }),
      'gpt-5.5-codex': expect.objectContaining({ outputTokens: 200 }),
    });
    // `null`: Codex's default, sent as no model.
    // `null`: back to Codex's default, named, since Codex keeps the last
    // turn's model; usage counts for it.
    await run.setModel(null);
    run.send(message('three'));
    const third = await events.result();
    expect(requests('turn/start')[2]).toEqual(
      expect.objectContaining({ model: 'gpt-5.5-codex' }),
    );
    expect(third.result.usage['gpt-5.5-codex']).toEqual(
      expect.objectContaining({ outputTokens: 400 }),
    );
  });

  it('resumes a thread by its rollout, also from another account’s home, and reads its history', async () => {
    const first = await start(message('remember this'));
    await first.events.result();
    const threadId = (first.events.all[0] as { engineSessionId: string })
      .engineSessionId;
    first.run.close();
    expect(await first.events.end()).toBeNull();

    // An account's home shares the base home's sessions.
    const account = join(dir, 'account');
    mkdirSync(account);
    symlinkSync(join(home, 'sessions'), join(account, 'sessions'));
    const second = await start(message('and this'), {
      resume: threadId,
      account: { configDir: account, main: false },
    });
    await second.events.result();
    expect(second.events.all[0]).toEqual(
      expect.objectContaining({ type: 'started', engineSessionId: threadId }),
    );
    const [resume] = requests('thread/resume', account);
    expect(resume).toEqual(
      expect.objectContaining({
        threadId,
        path: expect.stringMatching(
          new RegExp(`^${account}/sessions/.*-${threadId}\\.jsonl$`),
        ),
        cwd,
        approvalPolicy: 'untrusted',
      }),
    );
    expect(requests('thread/start', account)).toEqual([]);
    second.run.close();

    // The history is read without the session's directory or MCP servers.
    writeFileSync(
      join(home, 'fake-mcp-servers'),
      JSON.stringify({ docs: { command: 'docs-mcp' } }),
    );
    rmSync(cwd, { recursive: true });
    const history = await runner.history(threadId);
    const reads = requests('thread/resume', home);
    expect(reads.at(-1)).toEqual({
      threadId,
      path: expect.stringContaining(threadId),
      excludeTurns: true,
      config: {
        'mcp_servers.docs.enabled': false,
        'features.hooks': false,
      },
    });
    expect(existsSync(join(home, 'fake-mcp-started'))).toBe(false);
    const users = history.filter((entry) => entry.isUserMessage);
    expect(users.map((entry) => entry.events)).toEqual([
      [{ type: 'user.message', id: expect.any(String), text: 'remember this' }],
      [{ type: 'user.message', id: expect.any(String), text: 'and this' }],
    ]);
    expect(
      history.flatMap((entry) =>
        entry.events
          .filter((event) => event.type === 'assistant.text')
          .map((event) => (event as { text: string }).text),
      ),
    ).toEqual(['Echo: remember this', 'Echo: and this']);
    expect(
      await runner.history('00000000-0000-0000-0000-000000000000'),
    ).toEqual([]);

    const reader = new CodexTranscriptReader(runner, home, SINGLE_USER);
    expect(await reader.exists(threadId)).toBe(true);
    expect(await reader.exists('unknown')).toBe(false);
    expect(await reader.stamp(threadId)).toMatch(/^\d+@[\d.]+$/);
    expect(await reader.stamp('unknown')).toBeNull();
    expect((await reader.read(threadId)).length).toBe(history.length);
  });

  it('reports the script of a wrapped command, also for the push analysis', async () => {
    const { events } = await start(message('git-push'));
    const turn = await events.result();
    expect(approve.mock.calls[0][0].input).toEqual({
      command: 'git push origin HEAD',
      cwd,
    });
    expect(logOf(turn.events)).toContainEqual(
      expect.objectContaining({
        type: 'tool.call',
        name: 'Bash',
        input: { command: 'git push origin HEAD', cwd },
      }),
    );
  });

  it('runs commands allowed for the session without asking, also after a restart', async () => {
    const { run, events } = await start(message('run-command'), {
      allowedTools: ["Bash(echo 'hi')"],
    });
    let turn = await events.result();
    expect(approve).not.toHaveBeenCalled();
    expect(texts(turn.events)).toEqual(['decision: accept']);
    run.close();

    // A rule the user allows now counts for the rest of the process.
    const second = await start(message('git-push'));
    approve.mockResolvedValueOnce({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'git push origin HEAD' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
    turn = await second.events.result();
    expect(texts(turn.events)).toEqual(['decision: acceptForSession']);
    second.run.send(message('git-push'));
    turn = await second.events.result();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(texts(turn.events)).toEqual(['decision: accept']);
  });

  it('declines a command the app ran itself and tells the turn the outcome', async () => {
    approve.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { command: "printf '%s' 'x' | base64 -d" },
      ranByApp: { ok: true, output: 'pushed to origin' },
    });
    const { events } = await start(message('git-push'));
    const turn = await events.result();
    expect(texts(turn.events)).toEqual(['decision: decline']);
    const [steer] = requests('turn/steer');
    const threadId = (events.all[0] as { engineSessionId: string })
      .engineSessionId;
    expect(steer).toEqual({
      threadId,
      expectedTurnId: expect.stringMatching(/^turn-/),
      clientUserMessageId: expect.stringMatching(/^crm-app:/),
      input: [expect.objectContaining({ type: 'text' })],
      additionalContext: {
        crm_app_note: {
          kind: 'application',
          value: expect.stringContaining(
            'It succeeded. Output:\npushed to origin',
          ),
        },
      },
    });
    // The app's input is neither shown nor an anchor.
    expect(turn.events).not.toContainEqual(
      expect.objectContaining({
        type: 'output',
        anchor: expect.stringMatching(/^crm-app:/),
      }),
    );
    const history = await runner.history(threadId);
    expect(
      history.filter((entry) => entry.isUserMessage).map((e) => e.events),
    ).toEqual([
      [{ type: 'user.message', id: `client-${counter}`, text: 'git-push' }],
    ]);
  });

  it('sends context and note as additional context, and the history shows only the user’s text', async () => {
    const { events } = await start({
      id: 'with-context',
      text: 'look at #12',
      context: { id: 'ctx', text: 'Issue #12: broken' },
      note: { id: 'note', text: 'The user added a repository.' },
    });
    await events.result();
    expect(requests('turn/start')[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'look at #12', text_elements: [] }],
        additionalContext: {
          crm_context: {
            kind: 'untrusted',
            value: 'Issue #12: broken',
            name: 'github',
          },
          crm_note: {
            kind: 'application',
            value: 'The user added a repository.',
          },
        },
      }),
    );
    const threadId = (events.all[0] as { engineSessionId: string })
      .engineSessionId;
    const history = await runner.history(threadId);
    expect(history.find((entry) => entry.isUserMessage)?.events).toEqual([
      { type: 'user.message', id: 'with-context', text: 'look at #12' },
    ]);
  });

  it('keeps the thread’s tools when resumed with a changed tool list', async () => {
    const handler = jest.fn(async () => ({ text: 'ran' }));
    const tool = (name: string, unavailable?: string): AgentTool => ({
      name,
      description: name,
      inputSchema: (z) => ({ value: z.number() }),
      handler,
      ...(unavailable ? { unavailable } : {}),
    });
    const first = await start(message('hello'), {
      tools: [tool('show_file'), tool('create_pull_request', 'No GitHub.')],
      allowedTools: ['mcp__crm__create_pull_request'],
    });
    await first.events.result();
    // Registered although it cannot run now: Codex keeps a thread's tools.
    expect(
      (requests('thread/start')[0]['dynamicTools'] as { name: string }[]).map(
        (entry) => entry.name,
      ),
    ).toEqual(['show_file', 'create_pull_request']);
    const threadId = (first.events.all[0] as { engineSessionId: string })
      .engineSessionId;
    let turn = await (async () => {
      first.run.send(message('app-tool:create_pull_request'));
      return first.events.result();
    })();
    expect(texts(turn.events)).toEqual(['tool said: No GitHub.']);
    expect(approve).not.toHaveBeenCalled();
    first.run.close();

    // The next process: the tool can run, another one cannot any more.
    const second = await start(message('app-tool:create_pull_request'), {
      resume: threadId,
      tools: [tool('show_file', 'Gone.'), tool('create_pull_request')],
      allowedTools: ['mcp__crm__create_pull_request'],
    });
    turn = await second.events.result();
    expect(requests('thread/resume')[0]).not.toHaveProperty('dynamicTools');
    expect(texts(turn.events)).toEqual(['tool said: ran']);
    second.run.send(message('app-tool:show_file'));
    turn = await second.events.result();
    expect(texts(turn.events)).toEqual(['tool said: Gone.']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('counts only this process’s usage on top of what the app recorded', async () => {
    const first = await start(message('one'));
    const { result } = await first.events.result();
    expect(result.usage).toEqual({
      'gpt-5.5-codex': expect.objectContaining({ outputTokens: 200 }),
    });
    const threadId = (first.events.all[0] as { engineSessionId: string })
      .engineSessionId;
    first.run.close();

    // Codex restores the thread's total (1000 tokens) on resume: not new.
    const recorded = {
      inputTokens: 10,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 5,
      costUsd: 0,
    };
    const second = await start(message('two'), {
      resume: threadId,
      usageBaseline: { 'gpt-5.5-codex': recorded, 'other-model': recorded },
    });
    const resumed = await second.events.result();
    expect(resumed.result.usage).toEqual({
      'gpt-5.5-codex': {
        inputTokens: 10 + 300,
        outputTokens: 50 + 200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 5 + 500,
        costUsd: 0,
      },
    });
    // The context meter shows the restored usage at once.
    expect((await second.run.contextUsage()).usedTokens).toBe(1000);
  });

  it('stops waiting for the user when Codex resolves a request itself', async () => {
    let signal: AbortSignal | null = null;
    approve.mockImplementationOnce(
      (call) =>
        new Promise((resolve) => {
          signal = call.signal;
          call.signal.addEventListener('abort', () =>
            resolve({ behavior: 'deny', message: 'cancelled' }),
          );
        }),
    );
    const { events } = await start(message('resolve-itself'));
    const turn = await events.result();
    expect(texts(turn.events)).toEqual(['resolved by itself']);
    expect(signal).not.toBeNull();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
  });

  it('asks the model’s questions with the question card', async () => {
    approve.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { answers: { 'Which?': 'The second' } },
    });
    const { run, events } = await start(message('ask-user'));
    let turn = await events.result();
    expect(approve.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which?',
              header: 'Q',
              options: [],
              multiSelect: false,
            },
          ],
        },
      }),
    );
    expect(texts(turn.events)).toEqual([
      'answers: {"q1":{"answers":["The second"]}}',
    ]);
    // Declined: no answers, the turn goes on.
    approve.mockResolvedValueOnce({ behavior: 'deny', message: 'no' });
    run.send(message('ask-user'));
    turn = await events.result();
    expect(texts(turn.events)).toEqual(['answers: {}']);
  });

  it('interrupts a turn that is still starting once Codex names it', async () => {
    const { run, events } = await start(message('slow'));
    await run.interrupt();
    const { result } = await events.result();
    expect(result.isError).toBe(false);
    expect(requests('turn/interrupt')).toHaveLength(1);
  });

  it('keeps the newer turn’s ID when a turn starts and ends in one chunk', async () => {
    const { run, events } = await start(message('fast'));
    run.send(message('slow'));
    await events.result();
    // The slow turn has started; its ID, not the fast one's, is interrupted.
    await events.until(
      (event) =>
        event.type === 'output' && event.anchor === `client-${counter}`,
    );
    await run.interrupt();
    // At once: Codex knew the turn (it would refuse another one's ID).
    await events.until((event) => event.type === 'result', 3000);
    expect(requests('turn/interrupt')).toHaveLength(1);
  });

  it('kills Codex when it does not end after close', async () => {
    const { run, events } = await start(message('stubborn'));
    await events.result();
    const [pid] = fakeCodexPids(home);
    run.close();
    expect(await processEnded(pid, 1000)).toBe(false);
    expect(await processEnded(pid, 8000)).toBe(true);
  });

  const cmd = (script: string) =>
    message(`cmd:${Buffer.from(script).toString('base64')}`);
  const session = (toolName: string, ruleContent?: string) =>
    ({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [
            ruleContent === undefined
              ? { toolName }
              : { toolName, ruleContent },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    }) as AgentApprovalResult;

  it('reads commands allowed for the session exactly, never as wildcards', async () => {
    // Allowed for the session by an earlier process: exactly this command.
    const { run, events } = await start(cmd('rm -rf build/*'), {
      allowedTools: ['Bash(rm -rf build/*)', 'Bash(git status:*)'],
      sessionAllows: ['Bash(rm -rf build/*)'],
    });
    let turn = await events.result();
    expect(approve).not.toHaveBeenCalled();
    expect(texts(turn.events)).toEqual(['decision: accept']);
    for (const script of [
      'rm -rf build/ ~',
      'rm -rf build/x',
      'rm -rf build/* ~',
    ]) {
      approve.mockResolvedValueOnce({ behavior: 'deny', message: 'no' });
      run.send(cmd(script));
      turn = await events.result();
      expect(texts(turn.events)).toEqual(['decision: decline']);
    }
    expect(approve).toHaveBeenCalledTimes(3);
    // A configured rule (not a session allow) may be a prefix.
    approve.mockClear();
    run.send(cmd('git status --short'));
    turn = await events.result();
    expect(approve).not.toHaveBeenCalled();
    // Allowed now for the session: exact as well.
    approve.mockResolvedValueOnce(session('Bash', 'ls *'));
    run.send(cmd('ls *'));
    turn = await events.result();
    expect(texts(turn.events)).toEqual(['decision: acceptForSession']);
    approve.mockResolvedValueOnce({ behavior: 'deny', message: 'no' });
    run.send(cmd('ls ~/.ssh'));
    turn = await events.result();
    expect(texts(turn.events)).toEqual(['decision: decline']);
  });

  it('always asks before input to a running command, without an allow for the session', async () => {
    const { events } = await start(
      message(`stdin:${Buffer.from('y').toString('base64')}`),
      { allowedTools: ['Bash(y)'], sessionAllows: ['Bash(y)'] },
    );
    const turn = await events.result();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        title: 'Codex wants to send input to a running command',
        input: expect.objectContaining({ stdin: 'y' }),
        suggestions: [],
        suppressAlwaysAllow: true,
      }),
    );
    expect(texts(turn.events)).toEqual(['decision: accept']);
  });

  it('asks for the user’s MCP tools with a card, and remembers an allow for the session', async () => {
    approve.mockResolvedValueOnce({ behavior: 'deny', message: 'no' });
    const { run, events } = await start(message('mcp-tool'));
    let turn = await events.result();
    expect(approve.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        toolName: 'mcp__docs__search',
        input: { q: 'codex' },
        mcpServer: { name: 'docs', source: 'codex' },
        description: 'Allow the docs MCP server to run tool "search"?',
        suggestions: [
          expect.objectContaining({
            rules: [{ toolName: 'mcp__docs__search' }],
          }),
        ],
      }),
    );
    expect(texts(turn.events)).toEqual(['mcp answer: Cancel']);
    approve.mockResolvedValueOnce(session('mcp__docs__search'));
    run.send(message('mcp-tool'));
    turn = await events.result();
    // Codex is told "allow once"; the app keeps the session's allow.
    expect(texts(turn.events)).toEqual(['mcp answer: Allow']);
    run.send(message('mcp-tool'));
    turn = await events.result();
    expect(approve).toHaveBeenCalledTimes(2);
    expect(texts(turn.events)).toEqual(['mcp answer: Allow']);
    // Through an elicitation as well.
    run.send(message('mcp-elicit'));
    turn = await events.result();
    expect(texts(turn.events)).toEqual(['mcp answer: accept']);
  });

  it('declines an MCP elicitation approval the user denies', async () => {
    approve.mockResolvedValueOnce({ behavior: 'deny', message: 'no' });
    const { events } = await start(message('mcp-elicit'));
    const turn = await events.result();
    // The running call with the same server, tool and arguments.
    expect(approve.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        toolName: 'mcp__docs__search',
        input: { q: 'codex' },
        toolUseId: expect.stringMatching(/^mcp-/),
      }),
    );
    expect(texts(turn.events)).toEqual(['mcp answer: decline']);
  });

  it('builds an MCP approval card from the elicitation when no running call matches', async () => {
    const { events } = await start(message('mcp-elicit-other'));
    await events.result();
    expect(approve.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        toolName: 'mcp__docs__search',
        input: { q: 'other' },
        toolUseId: '',
        mcpServer: { name: 'docs', source: 'codex' },
      }),
    );
  });

  it('shows a subagent’s file change in its approval', async () => {
    const { events } = await start(message('subagent-edit'));
    await events.result();
    expect(approve.mock.calls[0][0].input).toEqual(
      expect.objectContaining({ file_path: join(cwd, 'notes.txt') }),
    );
  });

  it('allows changes of the same files for the session', async () => {
    approve.mockResolvedValueOnce(session('Edit', join(cwd, 'notes.txt')));
    const { run, events } = await start(message('edit-file'));
    let turn = await events.result();
    expect(approve.mock.calls[0][0].suggestions).toEqual([
      expect.objectContaining({
        rules: [{ toolName: 'Edit', ruleContent: join(cwd, 'notes.txt') }],
      }),
    ]);
    expect(texts(turn.events)).toEqual(['decision: acceptForSession']);
    run.send(message('edit-file'));
    turn = await events.result();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(texts(turn.events)).toEqual(['decision: accept']);
  });

  it('runs the app’s tools unasked in never, unless the gate asks; offers allowing one for the session', async () => {
    const handler = jest.fn(async () => ({ text: 'ran' }));
    const tool: AgentTool = {
      name: 'echo_tool',
      description: 'Echoes',
      inputSchema: (z) => ({ value: z.number() }),
      handler,
    };
    const never = await start(message('app-tool:echo_tool'), {
      tools: [tool],
      permissionMode: 'never',
      gate: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ decision: 'ask', reason: 'Check it' }),
    });
    let turn = await never.events.result();
    expect(approve).not.toHaveBeenCalled();
    expect(texts(turn.events)).toEqual(['tool said: ran']);
    never.run.send(message('app-tool:echo_tool'));
    await never.events.result();
    expect(approve).toHaveBeenCalledTimes(1);
    never.run.close();

    approve.mockClear();
    approve.mockResolvedValueOnce(session('mcp__crm__echo_tool'));
    const asks = await start(message('app-tool:echo_tool'), { tools: [tool] });
    await asks.events.result();
    expect(approve.mock.calls[0][0].suggestions).toEqual([
      expect.objectContaining({ rules: [{ toolName: 'mcp__crm__echo_tool' }] }),
    ]);
    asks.run.send(message('app-tool:echo_tool'));
    turn = await asks.events.result();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(texts(turn.events)).toEqual(['tool said: ran']);
  });

  it('closes open approvals when Codex exits', async () => {
    let signal: AbortSignal | null = null;
    approve.mockImplementationOnce(
      (call) =>
        new Promise((resolve) => {
          signal = call.signal;
          call.signal.addEventListener('abort', () =>
            resolve({ behavior: 'deny', message: 'gone' }),
          );
        }),
    );
    const { events } = await start(message('run-command'));
    for (let i = 0; i < 500 && signal === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [pid] = fakeCodexPids(home);
    process.kill(pid, 'SIGKILL');
    expect(await events.end()).toBeInstanceOf(Error);
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
  });

  it('deletes a deleted session’s thread in every Codex home', async () => {
    const account = join(
      home,
      'crm-accounts',
      '00000000-0000-0000-0000-00000000000a',
    );
    mkdirSync(account, { recursive: true });
    mkdirSync(join(home, 'sessions'), { recursive: true });
    symlinkSync(join('..', '..', 'sessions'), join(account, 'sessions'));
    const { run, events } = await start(message('hello'), {
      account: { configDir: account, main: false },
    });
    await events.result();
    const threadId = (events.all[0] as { engineSessionId: string })
      .engineSessionId;
    await run.close();
    const path = await findRollout(home, threadId);
    expect(path).not.toBeNull();
    const reader = new CodexTranscriptReader(runner, home, SINGLE_USER);
    await reader.remove(threadId);
    // Each home is asked (the account's first); the rollout is gone.
    expect(requests('thread/delete', account)).toEqual([{ threadId }]);
    expect(requests('thread/delete', home)).toEqual([{ threadId }]);
    expect(existsSync(path as string)).toBe(false);
    expect(await reader.exists(threadId)).toBe(false);
  });

  it('removes what is left of the rollouts itself, never through symlinks', async () => {
    const { run, events } = await start(message('hello'));
    await events.result();
    const threadId = (events.all[0] as { engineSessionId: string })
      .engineSessionId;
    await run.close();
    const path = await findRollout(home, threadId);
    writeFileSync(join(home, 'fake-delete-fails'), '');
    // A link with a rollout's name, pointing outside: left alone.
    const outside = join(dir, 'precious.txt');
    writeFileSync(outside, 'keep');
    mkdirSync(join(home, 'archived_sessions'), { recursive: true });
    const link = join(home, 'archived_sessions', `rollout-x-${threadId}.jsonl`);
    symlinkSync(outside, link);
    const reader = new CodexTranscriptReader(runner, home, SINGLE_USER);
    await reader.remove(threadId);
    expect(existsSync(path as string)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('finds archived rollouts too', async () => {
    const { run, events } = await start(message('hello'));
    await events.result();
    const threadId = (events.all[0] as { engineSessionId: string })
      .engineSessionId;
    await run.close();
    const path = (await findRollout(home, threadId)) as string;
    mkdirSync(join(home, 'archived_sessions'), { recursive: true });
    const archived = join(home, 'archived_sessions', basename(path));
    renameSync(path, archived);
    expect(await findRollout(home, threadId)).toBe(archived);
  });

  it('survives malformed messages of Codex', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { events } = await start(message('garbage'));
    const turn = await events.result();
    expect(texts(turn.events)).toEqual(['after garbage']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Could not handle a message of Codex/),
    );
    warn.mockRestore();
  });

  it('resolves close once Codex has ended', async () => {
    const { run, events } = await start(message('hello'));
    await events.result();
    const [pid] = fakeCodexPids(home);
    await run.close();
    expect(await processEnded(pid, 0)).toBe(true);
  });

  it('ends the events with an error when Codex exits', async () => {
    const { events } = await start(message('crash'));
    await events.until((event) => event.type === 'started');
    const error = await events.end();
    expect(error?.message).toMatch(/^Codex ended \(exit code 3\)/);
    expect(error?.message).toContain('panicked: fake crash');
  });

  it('ends Codex when the thread cannot be resumed', async () => {
    await expect(
      runner.start(
        options({ resume: '00000000-0000-0000-0000-000000000000' }),
        message('hello'),
      ),
    ).rejects.toThrow(/no rollout found/);
    const [pid] = fakeCodexPids(home);
    expect(await processEnded(pid)).toBe(true);
  });

  it('fails to start when Codex is missing', async () => {
    const missing = new CodexRunner(
      { executable: join(dir, 'no-codex'), baseHome: home },
      SINGLE_USER,
    );
    await expect(missing.start(options(), message('hello'))).rejects.toThrow();
  });

  describe('reviews', () => {
    const schema = { type: 'object', properties: {} };
    const review = (overrides: Partial<AgentReviewOptions> = {}) =>
      runner.review({
        cwd,
        additionalDirectories: [join(dir, 'other')],
        model: null,
        effort: 'high',
        prompt: 'Review this. review-json',
        instructions: 'Be an independent reviewer.',
        schema,
        signal: new AbortController().signal,
        ...overrides,
      });

    it('runs one read-only, ephemeral turn with the schema and returns its answer', async () => {
      const account = join(dir, 'account');
      mkdirSync(account);
      writeFileSync(
        join(account, 'fake-mcp-servers'),
        JSON.stringify({ docs: { command: 'docs' } }),
      );
      const result = await review({
        account: { configDir: account, main: false },
      });
      expect(result).toEqual({
        output: {
          summary: 'One problem.',
          findings: [
            expect.objectContaining({
              title: 'Found with high on gpt-5.5-codex',
              detail: 'Schema: given',
            }),
          ],
        },
        error: null,
        modelUsage: {
          'gpt-5.5-codex': expect.objectContaining({ outputTokens: 200 }),
        },
        durationMs: expect.any(Number),
        model: 'gpt-5.5-codex',
        effort: 'high',
      });
      const at = (method: string) => requests(method, account);
      expect(at('thread/start')).toEqual([
        expect.objectContaining({
          cwd,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          ephemeral: true,
          dynamicTools: [],
          developerInstructions: 'Be an independent reviewer.',
          config: expect.objectContaining({
            'mcp_servers.docs.enabled': false,
            'features.hooks': false,
            'features.browser_use': false,
            'features.computer_use': false,
            'features.image_generation': false,
            'features.apps': false,
            'features.plugins': false,
            'features.multi_agent': false,
            'features.goals': false,
          }),
        }),
      ]);
      expect(at('thread/start')[0]['config']).toMatchObject({
        // The repository's own .codex/config.toml does not load.
        projects: { [cwd]: { trust_level: 'untrusted' } },
        shell_environment_policy: { inherit: 'core', set: {} },
        web_search: 'cached',
      });
      // The project's MCP servers too.
      expect(at('config/read')).toEqual([{ cwd }]);
      expect(at('thread/start')[0]).not.toHaveProperty('model');
      expect(at('turn/start')).toEqual([
        expect.objectContaining({
          effort: 'high',
          outputSchema: schema,
          approvalPolicy: 'never',
          input: [
            {
              type: 'text',
              text: 'Review this. review-json',
              text_elements: [],
            },
          ],
        }),
      ]);
      // No rollout, and nothing in the base home.
      expect(existsSync(join(account, 'sessions'))).toBe(false);
      expect(fakeCodexRequests(home)).toEqual([]);
      // The app server has ended.
      expect(await processEnded(fakeCodexPids(account)[0])).toBe(true);
    });

    const decisions = (result: { output: unknown }) =>
      (
        result.output as { findings: { detail: string }[] }
      ).findings[0].detail.split('\n');

    it('probes Codex’s sandbox once, and refuses every request with it', async () => {
      const result = await review({ prompt: 'review-commands' });
      expect(decisions(result)).toEqual([
        'cat work.txt: decline',
        'git diff: decline',
        'touch pwned: decline',
        'cat work.txt > copy: decline',
        'rg --pre sh x: decline',
        'file change: decline',
      ]);
      await review();
      expect(
        readFileSync(join(home, 'fake-sandbox-probes'), 'utf8').split('\n'),
      ).toEqual(['probe', '']);
    });

    it('refuses to review where Codex’s sandbox cannot start, and probes again later', async () => {
      writeFileSync(join(home, 'fake-sandbox-fails'), '');
      expect(await runner.reviewBlocked({ cwd })).toBe(
        "Codex's sandbox cannot start on this server (it needs unprivileged user namespaces)",
      );
      const refused = review();
      await expect(refused).rejects.toBeInstanceOf(AgentReviewRefused);
      await expect(refused).rejects.toThrow('sandbox cannot start');
      expect(requests('thread/start')).toEqual([]);
      // A failure counts for a while only; then the sandbox is probed again.
      const probes = () =>
        readFileSync(join(home, 'fake-sandbox-probes'), 'utf8')
          .split('\n')
          .filter(Boolean).length;
      expect(probes()).toBe(1);
      rmSync(join(home, 'fake-sandbox-fails'));
      expect(await runner.sandboxWorks()).toBe(false);
      expect(await runner.sandboxWorks(Date.now() + 11 * 60_000)).toBe(true);
      expect(probes()).toBe(2);
      // A success is kept.
      expect(await runner.sandboxWorks(Date.now() + 60 * 60_000)).toBe(true);
      expect(probes()).toBe(2);
      expect(await runner.reviewBlocked({ cwd })).toBeNull();
    });

    it('counts the machine’s Codex rules too', async () => {
      const system = join(dir, 'etc-codex-rules');
      mkdirSync(system);
      expect(await codexRulesReason([home], cwd, system)).toBeNull();
      writeFileSync(
        join(system, 'managed.rules'),
        'prefix_rule(pattern=["rm"], decision="allow")\n',
      );
      expect(await codexRulesReason([home], cwd, system)).toContain(
        'managed.rules',
      );
    });

    it('refuses to review where Codex has command rules', async () => {
      expect(await runner.reviewBlocked({ cwd })).toBeNull();
      mkdirSync(join(home, 'rules'));
      writeFileSync(join(home, 'rules', 'default.rules'), '# nothing\n\n');
      expect(await runner.reviewBlocked({ cwd })).toBeNull();
      mkdirSync(join(cwd, '.codex', 'rules'), { recursive: true });
      writeFileSync(
        join(cwd, '.codex', 'rules', 'project.rules'),
        'prefix_rule(pattern=["touch"], decision="allow")\n',
      );
      expect(await runner.reviewBlocked({ cwd })).toContain('project.rules');
      // An account's own rules (its `rules/` is a link into the base
      // home's, followed).
      rmSync(join(cwd, '.codex'), { recursive: true });
      const account = join(dir, 'account');
      mkdirSync(account);
      symlinkSync(join(home, 'rules'), join(account, 'rules'));
      writeFileSync(
        join(home, 'rules', 'default.rules'),
        'prefix_rule(pattern=["rm"], decision="allow")\n',
      );
      expect(
        await runner.reviewBlocked({
          cwd,
          account: { configDir: account, main: false },
        }),
      ).toContain(join(account, 'rules', 'default.rules'));
      await expect(
        review({ account: { configDir: account, main: false } }),
      ).rejects.toThrow('command rules');
      expect(fakeCodexRequests(account)).toEqual([]);
    });

    it('lowers an effort the model does not offer', async () => {
      const result = await review({ model: 'gpt-5.4', effort: 'max' });
      expect(result).toMatchObject({ model: 'gpt-5.4', effort: 'xhigh' });
      expect(requests('turn/start')[0]).toMatchObject({
        model: 'gpt-5.4',
        effort: 'xhigh',
      });
      expect(requests('thread/start')[0]).toMatchObject({ model: 'gpt-5.4' });
    });

    it('fails without an answer in the format', async () => {
      const result = await review({ prompt: 'Just talk' });
      expect(result).toMatchObject({
        output: null,
        error: 'The reviewer did not answer in the requested format',
      });
    });

    it('reports a failed turn as its error', async () => {
      const result = await review({ prompt: 'limit' });
      expect(result).toMatchObject({
        output: null,
        error: "You've hit your usage limit.",
      });
    });

    it('interrupts the turn and ends Codex when aborted', async () => {
      const abort = new AbortController();
      const running = review({ prompt: 'slow', signal: abort.signal });
      await waitForRequest('turn/start');
      abort.abort();
      await expect(running).rejects.toThrow('The review was cancelled');
      expect(requests('turn/interrupt')).toHaveLength(1);
      expect(await processEnded(fakeCodexPids(home)[0])).toBe(true);
    });

    it('fails when Codex exits during the review', async () => {
      await expect(review({ prompt: 'crash' })).rejects.toThrow(/fake crash/);
    });

    const waitForRequest = async (method: string) => {
      const deadline = Date.now() + 5000;
      while (requests(method).length === 0) {
        if (Date.now() > deadline) {
          throw new Error(`No ${method} in time`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
  });
});

describe('codexReviewEffort', () => {
  const model = (efforts: string[], fallback = 'medium') => ({
    id: 'm',
    model: 'm',
    displayName: 'M',
    description: '',
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
    })),
    defaultReasoningEffort: fallback,
  });

  it('keeps an offered effort and lowers one that is not', () => {
    expect(codexReviewEffort(undefined, 'max')).toBe('max');
    expect(codexReviewEffort(model([]), 'max')).toBe('max');
    expect(codexReviewEffort(model(['low', 'high', 'max']), 'max')).toBe('max');
    expect(codexReviewEffort(model(['low', 'medium', 'high']), 'max')).toBe(
      'high',
    );
    expect(codexReviewEffort(model(['high', 'xhigh']), 'low')).toBe('high');
    expect(
      codexReviewEffort(model(['minimal', 'medium', 'xhigh'], 'xhigh'), 'low'),
    ).toBe('xhigh');
  });
});

describe('codexPolicy', () => {
  it('maps Codex’s modes and falls back to untrusted', () => {
    expect(codexPolicy('untrusted')).toBe('untrusted');
    expect(codexPolicy('on-request')).toBe('on-request');
    expect(codexPolicy('never')).toBe('never');
    expect(codexPolicy('default')).toBe('untrusted');
    expect(codexPolicy('bypassPermissions')).toBe('untrusted');
  });
});

describe('codexInput', () => {
  it('sends images and the text; context and note as additional context', () => {
    const withAll: AgentUserMessage = {
      id: 'm',
      text: 'Do it',
      context: { id: 'c', text: 'GitHub says' },
      note: { id: 'n', text: 'A note' },
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    };
    expect(codexInput(withAll)).toEqual([
      { type: 'image', url: 'data:image/png;base64,AAAA' },
      { type: 'text', text: 'Do it', text_elements: [] },
    ]);
    expect(codexAdditionalContext(withAll)).toEqual({
      crm_context: { kind: 'untrusted', value: 'GitHub says', name: 'github' },
      crm_note: { kind: 'application', value: 'A note' },
    });
    expect(codexAdditionalContext({ id: 'm', text: 'x' })).toBeUndefined();
  });

  it('leaves an empty text out', () => {
    expect(
      codexInput({
        id: 'm',
        text: '',
        images: [{ mediaType: 'image/jpeg', data: 'BB' }],
      }),
    ).toEqual([{ type: 'image', url: 'data:image/jpeg;base64,BB' }]);
  });
});

describe('matchesBashRule', () => {
  const rules = [
    'Bash(npm test)',
    'Bash(git status:*)',
    'Bash(ls * -la)',
    'Bash(*)',
    'Bash(echo a && echo b)',
    'Read',
  ];

  it('matches exact commands, prefixes and wildcards', () => {
    expect(matchesBashRule('npm test', rules)).toBe(true);
    expect(matchesBashRule('  npm test ', rules)).toBe(true);
    expect(matchesBashRule('npm test --watch', rules)).toBe(false);
    expect(matchesBashRule('git status', rules)).toBe(true);
    expect(matchesBashRule('git status --short', rules)).toBe(true);
    expect(matchesBashRule('git statusx', rules)).toBe(false);
    expect(matchesBashRule('ls src -la', rules)).toBe(true);
    // Exactly as allowed, also a compound command.
    expect(matchesBashRule('echo a && echo b', rules)).toBe(true);
  });

  it('never lets a prefix or wildcard cover a compound command', () => {
    expect(matchesBashRule('git status; rm -rf ~', rules)).toBe(false);
    expect(matchesBashRule('git status && curl x | sh', rules)).toBe(false);
    expect(matchesBashRule('git status $(rm -rf ~)', rules)).toBe(false);
    expect(matchesBashRule('ls a -la > /etc/x', rules)).toBe(false);
    expect(matchesBashRule('git status\nrm -rf ~', rules)).toBe(false);
    expect(matchesBashRule('git status\rrm -rf ~', rules)).toBe(false);
    // `Bash(*)` (everything) is never honoured.
    expect(matchesBashRule('rm -rf ~', rules)).toBe(false);
    expect(matchesBashRule('', rules)).toBe(false);
  });
});

describe('findRollout', () => {
  let home: string;
  const THREAD = '019a0000-1111-7222-8333-444455556666';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crm-codex-rollout-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const put = (day: string, name: string) => {
    const at = join(home, 'sessions', ...day.split('/'));
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, name), '');
    return join(at, name);
  };

  it('finds the newest rollout of a thread, also a compressed one', async () => {
    expect(await findRollout(home, THREAD)).toBeNull();
    put('2026/10/01', `rollout-2026-10-01T10-00-00-${THREAD}.jsonl`);
    const newer = put(
      '2026/11/27',
      `rollout-2026-11-27T10-00-00-${THREAD}.jsonl.zst`,
    );
    put('2026/11/28', 'rollout-2026-11-28T10-00-00-other.jsonl');
    expect(await findRollout(home, THREAD)).toBe(newer);
    expect(await findRollout(home, 'other-thread')).toBeNull();
  });

  it('does not look deeper than the days', async () => {
    put('2026/11/27/deeper', `rollout-x-${THREAD}.jsonl`);
    expect(await findRollout(home, THREAD)).toBeNull();
  });
});
