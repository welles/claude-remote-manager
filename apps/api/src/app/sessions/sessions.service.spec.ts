import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateSessionRequest,
  SessionDto,
  SessionEvent,
} from '@claude-remote-manager/shared-types';
import type { AppConfig } from '../config/app-config';
import { openDatabase, type AppDatabase } from '../db/database';
import { LimitsService } from '../limits/limits.service';
import { SessionEventRepository } from './session-event.repository';
import { SessionRepository } from './session.repository';
import {
  NO_APPROVAL_UI_MESSAGE,
  SessionsService,
  titleFromPrompt,
  type SessionEventEnvelope,
} from './sessions.service';
import {
  FakeAgentRunner,
  FakeTranscriptReader,
  flush,
  resultMessage,
} from './testing/fake-agent';
import { UsageRepository } from './usage.repository';

const MSG_2 = '2b1f4c2e-8f3a-4d6b-9c1e-0a7d5e3f2b10';
const MSG_3 = '3c2e5d3f-9a4b-4e7c-8d2f-1b8e6f4a3c21';

describe('SessionsService', () => {
  let dir: string;
  let db: AppDatabase;
  let config: AppConfig;
  let runner: FakeAgentRunner;
  let transcripts: FakeTranscriptReader;
  let limits: LimitsService;
  let service: SessionsService;
  let events: SessionEventEnvelope[];
  let updates: SessionDto[];

  const createService = () => {
    const created = new SessionsService(
      config,
      new SessionRepository(db),
      new UsageRepository(db),
      new SessionEventRepository(db),
      runner,
      transcripts,
      limits,
    );
    created.onModuleInit();
    created.events$.subscribe((event) => events.push(event));
    created.updates$.subscribe((update) => updates.push(update));
    return created;
  };

  const eventTypes = () => events.map(({ event }) => event.type);
  const lastEvent = <T extends SessionEvent['type']>(type: T) =>
    events
      .map(({ event }) => event)
      .filter(
        (event): event is Extract<SessionEvent, { type: T }> =>
          event.type === type,
      )
      .at(-1);

  /** Creates a session and lets its process start. */
  const startSession = async () => {
    const session = await service.create({
      prompt: 'Reply with pong',
      model: 'haiku',
    });
    await flush();
    return session;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-sessions-'));
    db = openDatabase(':memory:');
    config = {
      dbDir: ':memory:',
      sessionCwd: join(dir, 'scratch'),
      sessionAdditionalDirectories: ['/extra'],
      sessionIdleTimeoutMs: 0,
      claudeExecutable: null,
      allowedOrigins: [],
      allowedHosts: [],
    };
    runner = new FakeAgentRunner();
    transcripts = new FakeTranscriptReader();
    limits = new LimitsService();
    events = [];
    updates = [];
    service = createService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('starts a Claude Code process in the configured directory', async () => {
      const session = await startSession();

      expect(session).toMatchObject({
        status: 'running',
        title: 'Reply with pong',
        model: 'haiku',
        permissionMode: 'default',
        cwd: config.sessionCwd,
        additionalDirectories: ['/extra'],
        sdkSessionId: null,
        usage: { inputTokens: 0, costUsd: 0 },
      });
      expect(runner.runs).toHaveLength(1);
      expect(runner.last.options).toMatchObject({
        cwd: config.sessionCwd,
        additionalDirectories: ['/extra'],
        model: 'haiku',
        permissionMode: 'default',
        resume: null,
        sessionId: session.id,
      });
      expect(runner.last.sent).toEqual([
        { id: expect.any(String), text: 'Reply with pong' },
      ]);
      expect(eventTypes()).toEqual(['session.status', 'user.message']);
      expect(updates.at(-1)?.id).toBe(session.id);
    });

    it('derives a title from the first line of the prompt', async () => {
      expect(titleFromPrompt('  Fix the build\nDetails follow')).toBe(
        'Fix the build',
      );
      expect(titleFromPrompt('x'.repeat(100))).toHaveLength(80);
      const session = await service.create({ prompt: 'p', title: ' Mine ' });
      expect(session.title).toBe('Mine');
    });

    it('validates the request', async () => {
      await expect(service.create({ prompt: '  ' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.create({ prompt: 'x', model: 'haiku; rm -rf /' }),
      ).rejects.toThrow('model');
      await expect(
        service.create({
          prompt: 'x',
          permissionMode: 'bypassPermissions' as never,
        }),
      ).rejects.toThrow('permissionMode must be one of');
      const invalid: unknown[] = [
        null,
        'prompt',
        [],
        { prompt: 5 },
        { prompt: 'x', title: 5 },
        { prompt: 'x', model: {} },
        { prompt: 'x', permissionMode: 1 },
      ];
      for (const request of invalid) {
        await expect(
          service.create(request as CreateSessionRequest),
        ).rejects.toThrow(BadRequestException);
      }
      expect(runner.runs).toHaveLength(0);
    });

    it('validates messages', async () => {
      const session = await startSession();
      const invalid: unknown[] = [
        null,
        { text: 5 },
        { text: ' ' },
        { text: 'x', id: 'not-a-uuid' },
        { text: 'x', id: 7 },
      ];
      for (const message of invalid) {
        await expect(
          service.send(session.id, message as { text: string }),
        ).rejects.toThrow(BadRequestException);
      }
      await service.send(session.id, { text: 'no id' });
      expect(runner.last.sent.at(-1)?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('marks the session failed when the process cannot start', async () => {
      runner.failNextStart = new Error('Native CLI binary not found');
      const session = await startSession();

      expect(service.get(session.id)).toMatchObject({
        status: 'failed',
        lastError: 'Native CLI binary not found',
      });
      expect(lastEvent('error')?.message).toBe('Native CLI binary not found');
    });
  });

  describe('streaming', () => {
    it('maps messages, records usage and waits for the user after a turn', async () => {
      const session = await startSession();
      const run = runner.last;

      run.emit(
        { type: 'system', subtype: 'init', session_id: 'sdk-1' },
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'm1' } },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text' },
          },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'po' },
          },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ng' },
          },
        },
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'm1', content: [{ type: 'text', text: 'pong' }] },
        },
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed',
            rateLimitType: 'five_hour',
            utilization: 0.1,
          },
        },
        resultMessage(10, 0.01),
      );
      await flush();

      expect(eventTypes()).toEqual([
        'session.status',
        'user.message',
        'assistant.delta',
        'assistant.delta',
        'assistant.text',
        'turn.result',
        'session.status',
        'context.usage',
      ]);
      expect(lastEvent('turn.result')).toMatchObject({
        subtype: 'success',
        interrupted: false,
        durationMs: 1500,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 0,
          costUsd: 0.01,
        },
      });
      expect(lastEvent('context.usage')?.context).toMatchObject({
        usedTokens: 1200,
        maxTokens: 200_000,
      });

      const dto = service.get(session.id);
      expect(dto).toMatchObject({
        status: 'waiting',
        sdkSessionId: 'sdk-1',
        usage: { inputTokens: 10, costUsd: 0.01 },
        context: { usedTokens: 1200 },
      });
      expect(limits.get().windows[0]).toMatchObject({
        type: 'five_hour',
        utilization: 10,
      });

      // The log replaces streamed deltas by the complete text.
      const history = await service.subscribe(session.id);
      expect(history.events.map((event) => event.type)).toEqual([
        'session.status',
        'user.message',
        'assistant.text',
        'turn.result',
        'session.status',
        'context.usage',
      ]);
      expect(history.events.map((event) => event.seq)).toEqual([
        1, 2, 5, 6, 7, 8,
      ]);
    });

    it('sends follow-up messages into the running process', async () => {
      const session = await startSession();
      runner.last.emit(resultMessage(10, 0.01));
      await flush();

      await service.send(session.id, { id: MSG_2, text: 'Again' });

      expect(runner.runs).toHaveLength(1);
      expect(runner.last.sent.at(-1)).toEqual({ id: MSG_2, text: 'Again' });
      expect(service.get(session.id).status).toBe('running');
      expect(lastEvent('user.message')).toMatchObject({
        id: MSG_2,
        text: 'Again',
      });

      runner.last.emit(resultMessage(25, 0.03));
      await flush();
      // Cumulative results are recorded as differences.
      expect(lastEvent('turn.result')?.usage).toMatchObject({
        inputTokens: 15,
        costUsd: 0.02,
      });
      expect(service.get(session.id).usage).toMatchObject({
        inputTokens: 25,
        costUsd: 0.03,
      });
    });

    it('stays running while queued messages follow', async () => {
      const session = await startSession();
      runner.last.emit(resultMessage(10, 0.01, { queued_turn_count: 1 }));
      await flush();
      expect(service.get(session.id).status).toBe('running');
    });

    it('reports failed turns but keeps the session', async () => {
      const session = await startSession();
      runner.last.emit(
        resultMessage(1, 0, {
          subtype: 'error_max_turns',
          errors: ['Too many turns'],
        }),
      );
      await flush();

      expect(lastEvent('error')?.message).toBe('Too many turns');
      expect(service.get(session.id).status).toBe('waiting');

      runner.last.emit(
        resultMessage(1, 0, { is_error: true, result: 'Prompt is too long' }),
      );
      await flush();
      expect(lastEvent('error')?.message).toBe('Prompt is too long');

      // Not repeated when the assistant already said it.
      const errors = () => events.filter(({ event }) => event.type === 'error');
      const before = errors().length;
      runner.last.emit(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          error: 'authentication_failed',
          message: {
            id: 'm9',
            content: [{ type: 'text', text: 'Failed to authenticate' }],
          },
        },
        resultMessage(1, 0, {
          is_error: true,
          result: 'Failed to authenticate',
        }),
      );
      await flush();
      expect(errors()).toHaveLength(before);
      expect(lastEvent('notice')?.text).toBe(
        'API error: authentication_failed',
      );
    });
  });

  describe('interrupt', () => {
    it('interrupts the running turn', async () => {
      const session = await startSession();

      await service.interrupt(session.id);
      expect(runner.last.interrupted).toBe(1);

      runner.last.emit(
        resultMessage(5, 0.005, {
          subtype: 'error_during_execution',
          errors: ['aborted'],
        }),
      );
      await flush();
      expect(lastEvent('turn.result')).toMatchObject({ interrupted: true });
      expect(lastEvent('error')).toBeUndefined();
      expect(service.get(session.id).status).toBe('waiting');
    });

    it('rejects interrupting a session that does not run', async () => {
      const session = await startSession();
      runner.last.emit(resultMessage(1, 0));
      await flush();

      await expect(service.interrupt(session.id)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.interrupt('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('permissions', () => {
    it('denies tool uses that need approval, visibly', async () => {
      await startSession();
      const decision = await runner.last.options.canUseTool(
        'Bash',
        { command: 'rm file' },
        {
          signal: new AbortController().signal,
          toolUseID: 'tool-1',
          requestId: 'r1',
        },
      );

      expect(decision).toEqual({
        behavior: 'deny',
        message: NO_APPROVAL_UI_MESSAGE,
      });
      expect(lastEvent('permission.denied')).toMatchObject({
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: { command: 'rm file' },
        reason: 'no_approval_ui',
        message: NO_APPROVAL_UI_MESSAGE,
      });
      expect(NO_APPROVAL_UI_MESSAGE).toContain('not implemented');
    });
  });

  describe('process end and resume', () => {
    it('finishes when the process ends and resumes with the next message', async () => {
      const session = await startSession();
      runner.last.emit(
        { type: 'system', subtype: 'init', session_id: 'sdk-1' },
        resultMessage(10, 0.01),
      );
      await flush();
      runner.last.close();
      await flush();
      expect(service.get(session.id).status).toBe('finished');

      await service.send(session.id, { id: MSG_2, text: 'Still there?' });
      await flush();

      expect(runner.runs).toHaveLength(2);
      expect(runner.last.options).toMatchObject({
        resume: 'sdk-1',
        sessionId: null,
      });
      expect(runner.last.sent).toEqual([{ id: MSG_2, text: 'Still there?' }]);
      expect(service.get(session.id).status).toBe('running');

      // A resumed process continues the cumulative totals of the transcript.
      runner.last.emit(resultMessage(14, 0.015));
      await flush();
      expect(lastEvent('turn.result')?.usage).toMatchObject({
        inputTokens: 4,
        costUsd: 0.005,
      });
    });

    it('marks crashed sessions failed and clears the error on resume', async () => {
      const session = await startSession();
      runner.last.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-1',
      });
      runner.last.crash(new Error('Claude Code process exited with code 1'));
      await flush();

      expect(service.get(session.id)).toMatchObject({
        status: 'failed',
        lastError: 'Claude Code process exited with code 1',
      });
      expect(lastEvent('error')?.message).toContain('exited');

      await service.send(session.id, { id: MSG_3, text: 'retry' });
      await flush();
      expect(service.get(session.id)).toMatchObject({
        status: 'running',
        lastError: null,
      });
      expect(runner.last.options.resume).toBe('sdk-1');
    });

    it('loads the history from the transcript after a server restart', async () => {
      const session = await startSession();
      runner.last.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-1',
      });
      await flush();
      service.onModuleDestroy();
      expect(runner.last.closed).toBe(true);
      expect(new SessionRepository(db).require(session.id).status).toBe(
        'finished',
      );

      transcripts.transcripts.set('sdk-1', [
        {
          type: 'user',
          uuid: 'u1',
          session_id: 'sdk-1',
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { role: 'user', content: 'Reply with pong' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          session_id: 'sdk-1',
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: 'pong' }],
          },
        },
      ]);
      service = createService();

      const history = await service.subscribe(session.id);
      expect(transcripts.reads).toEqual([
        { sdkSessionId: 'sdk-1', cwd: config.sessionCwd },
      ]);
      expect(history.session.status).toBe('finished');
      expect(history.events).toEqual([
        expect.objectContaining({
          seq: 1,
          type: 'user.message',
          text: 'Reply with pong',
        }),
        expect.objectContaining({
          seq: 2,
          type: 'assistant.text',
          text: 'pong',
        }),
      ]);

      await service.send(session.id, { id: MSG_3, text: 'Once more' });
      await flush();
      expect(runner.last.options.resume).toBe('sdk-1');
      expect(
        (await service.subscribe(session.id)).events.map((e) => e.seq),
      ).toEqual([1, 2, 3, 4]);
      expect(transcripts.reads).toHaveLength(1);
    });

    it('closes idle processes', async () => {
      config.sessionIdleTimeoutMs = 20;
      service = createService();
      const session = await startSession();
      runner.last.emit(resultMessage(1, 0));
      await flush();
      expect(service.get(session.id).status).toBe('waiting');

      await new Promise((resolve) => setTimeout(resolve, 60));
      await flush();
      expect(runner.last.closed).toBe(true);
      expect(service.get(session.id).status).toBe('finished');
      expect(lastEvent('error')).toBeUndefined();
    });
  });

  describe('event log', () => {
    it('answers subscriptions incrementally and with drafts', async () => {
      const session = await startSession();
      const first = await service.subscribe(session.id);
      expect(first.complete).toBe(true);
      const lastSeq = first.events.at(-1)?.seq ?? 0;

      runner.last.emit(
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'm1' } },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text' },
          },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'po' },
          },
        },
        {
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 2,
          retry_delay_ms: 1,
          error_status: 529,
          error: 'overloaded',
        },
      );
      await flush();

      const later = await service.subscribe(session.id, {
        logId: first.logId,
        seq: lastSeq,
      });
      expect(later).toMatchObject({ logId: first.logId, complete: false });
      expect(later.events.map((event) => event.type)).toEqual(['notice']);
      expect(later.drafts).toEqual([
        { messageId: 'm1', blockIndex: 0, text: 'po', parentToolUseId: null },
      ]);

      const other = await service.subscribe(session.id, {
        logId: '00000000-0000-4000-8000-000000000000',
        seq: lastSeq,
      });
      expect(other.complete).toBe(true);
    });

    it('releases unused sessions and rebuilds them with stored events', async () => {
      const session = await startSession();
      const run = runner.last;
      const firstId = run.sent[0].id;
      run.emit(
        { type: 'system', subtype: 'init', session_id: 'sdk-1' },
        {
          type: 'assistant',
          uuid: 'a1',
          parent_tool_use_id: null,
          message: {
            id: 'm1',
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
        },
      );
      await flush();
      await run.options.canUseTool(
        'Bash',
        { command: 'ls' },
        {
          signal: new AbortController().signal,
          toolUseID: 't1',
          requestId: 'r',
        },
      );
      run.emit(
        {
          type: 'assistant',
          uuid: 'a2',
          parent_tool_use_id: null,
          message: { id: 'm2', content: [{ type: 'text', text: 'Denied.' }] },
        },
        resultMessage(10, 0.01),
      );
      await flush();
      run.close();
      await flush();
      expect(service.get(session.id).status).toBe('finished');
      expect(service.liveCount).toBe(0);
      expect(service.get(session.id).context).toBeNull();

      const message = (
        uuid: string,
        type: 'user' | 'assistant',
        content: unknown,
        id?: string,
      ) => ({
        type,
        uuid,
        session_id: 'sdk-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { id, role: type, content },
      });
      transcripts.transcripts.set('sdk-1', [
        message(firstId, 'user', 'Reply with pong'),
        message(
          'a1',
          'assistant',
          [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
          'm1',
        ),
        message('r1', 'user', [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'denied',
            is_error: true,
          },
        ]),
        message('a2', 'assistant', [{ type: 'text', text: 'Denied.' }], 'm2'),
      ]);

      const rebuilt = await service.subscribe(session.id);
      expect(rebuilt.events.map((event) => event.type)).toEqual([
        'user.message',
        'tool.call',
        'permission.denied',
        'tool.result',
        'assistant.text',
        'turn.result',
        'context.usage',
      ]);
      expect(rebuilt.events.map((event) => event.at === null)).toEqual([
        true,
        true,
        false,
        true,
        true,
        false,
        false,
      ]);
      expect(rebuilt.session.context).toMatchObject({ usedTokens: 1200 });

      // Kept while subscribed, released after the last unsubscribe.
      expect(service.liveCount).toBe(1);
      service.unsubscribe(session.id);
      expect(service.liveCount).toBe(0);
    });

    it('keeps errors of a session that never started', async () => {
      runner.failNextStart = new Error('Native CLI binary not found');
      const session = await startSession();
      expect(service.liveCount).toBe(0);
      const history = await service.subscribe(session.id);
      expect(history.events.map((event) => event.type)).toEqual(['error']);
      expect(transcripts.reads).toHaveLength(0);
    });
  });

  it('lists sessions with their usage', async () => {
    const first = await startSession();
    runner.last.emit(resultMessage(10, 0.01));
    await flush();
    const second = await startSession();

    const list = service.list();
    expect(list.map((session) => session.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(
      list.find((session) => session.id === first.id)?.usage.inputTokens,
    ).toBe(10);
    expect(
      list.find((session) => session.id === second.id)?.usage.inputTokens,
    ).toBe(0);
    expect(() => service.get('missing')).toThrow(NotFoundException);
  });
});
