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
import { type AppConfig, testAppConfig } from '../config/app-config';
import { openDatabase, type AppDatabase } from '../db/database';
import { GitService } from '../git/git.service';
import { createOrigin, gitSandbox } from '../git/testing/git-fixtures';
import { LimitsService } from '../limits/limits.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { RepositoryRepository } from '../repositories/repository.repository';
import { SessionWorkspaceService } from '../workspaces/session-workspace.service';
import { FakeGitHub } from '../github/testing/fake-github';
import { RepositoryCredentials } from '../repositories/repository-credentials';
import { SettingsService } from '../settings/settings.service';
import { withTestIdentity } from '../workspaces/testing/workspace-harness';
import { SetupScriptRunner } from '../workspaces/setup-script-runner';
import { SessionEventRepository } from './session-event.repository';
import { SessionRepository } from './session.repository';
import {
  NO_APPROVAL_UI_MESSAGE,
  RESTART_NOTICE,
  SessionsService,
  titleFromPrompt,
  type SessionEventEnvelope,
} from './sessions.service';
import {
  FakeAgentRunner,
  FakeTranscriptReader,
  flush,
  resultMessage,
  waitFor,
} from './testing/fake-agent';
import { UsageRepository } from './usage.repository';

const MSG_2 = '2b1f4c2e-8f3a-4d6b-9c1e-0a7d5e3f2b10';
const MSG_3 = '3c2e5d3f-9a4b-4e7c-8d2f-1b8e6f4a3c21';
const REPO_ID = '7d0a3c2e-1b4f-4e6a-9c8d-2f1e0a9b8c7d';

/** Preparation events; most tests here look at the conversation only. */
const PREPARATION_TYPES = new Set([
  'prepare.progress',
  'setup.output',
  'setup.result',
]);
const conversation = <T extends { type: string }>(events: T[]) =>
  events.filter((event) => !PREPARATION_TYPES.has(event.type));

describe('SessionsService', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let dir: string;
  let db: AppDatabase;
  let git: GitService;
  let config: AppConfig;
  let runner: FakeAgentRunner;
  let transcripts: FakeTranscriptReader;
  let limits: LimitsService;
  let service: SessionsService;
  let events: SessionEventEnvelope[];
  let updates: SessionDto[];

  const createService = async () => {
    const sessions = new SessionRepository(db);
    const settings = withTestIdentity(new SettingsService(db));
    const github = new FakeGitHub();
    const records = new RepositoryRepository(db);
    const repositories = new RepositoriesService(
      config,
      records,
      git,
      settings,
      new RepositoryCredentials(github.service, records),
      github.service,
    );
    const created = new SessionsService(
      config,
      sessions,
      new UsageRepository(db),
      new SessionEventRepository(db),
      runner,
      transcripts,
      limits,
      new SessionWorkspaceService(
        config,
        sessions,
        repositories,
        git,
        new SetupScriptRunner(),
        settings,
      ),
    );
    await created.onModuleInit();
    created.events$.subscribe((event) => events.push(event));
    created.updates$.subscribe((update) => updates.push(update));
    return created;
  };

  const eventTypes = () =>
    conversation(events.map(({ event }) => event)).map((event) => event.type);
  const lastEvent = <T extends SessionEvent['type']>(type: T) =>
    events
      .map(({ event }) => event)
      .filter(
        (event): event is Extract<SessionEvent, { type: T }> =>
          event.type === type,
      )
      .at(-1);

  /** Waits until the preparation is over and the process started (or not). */
  const prepared = async (sessionId: string, runsBefore: number) => {
    await waitFor(
      () =>
        runner.runs.length > runsBefore ||
        !['preparing', 'running'].includes(service.get(sessionId).status),
    );
    await flush();
  };

  /** Creates a session on the test repository and lets its process start. */
  const startSession = async (request: Partial<CreateSessionRequest> = {}) => {
    const runsBefore = runner.runs.length;
    const session = await service.create({
      prompt: 'Reply with pong',
      model: 'haiku',
      repositories: [{ repositoryId: REPO_ID }],
      ...request,
    });
    await prepared(session.id, runsBefore);
    return session;
  };

  /** Clone of the test repository for a session. */
  const cloneOf = (session: SessionDto) =>
    join(config.sessionsDir, session.slug ?? '', 'acme', 'tool');

  beforeEach(async () => {
    sandbox = gitSandbox('crm-sessions-');
    dir = sandbox.dir;
    db = openDatabase(':memory:');
    git = new GitService();
    config = testAppConfig(dir);
    const origin = join(dir, 'origin', 'acme', 'tool');
    await createOrigin(origin);
    new RepositoryRepository(db).create({
      id: REPO_ID,
      owner: 'acme',
      name: 'tool',
      cloneUrl: origin,
      localPath: join(config.reposDir, 'acme', 'tool'),
      setupScript: null,
    });
    runner = new FakeAgentRunner();
    transcripts = new FakeTranscriptReader();
    limits = new LimitsService();
    events = [];
    updates = [];
    service = await createService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    db.$client.close();
    sandbox.cleanup();
  });

  describe('create', () => {
    it('starts a Claude Code process in the clone of the main repository', async () => {
      const session = await startSession();

      expect(session).toMatchObject({
        status: 'preparing',
        title: 'Reply with pong',
        model: 'haiku',
        permissionMode: 'default',
        slug: expect.stringMatching(/^reply-with-pong-[a-z0-9]{6}$/),
        cwd: cloneOf(session),
        additionalDirectories: [],
        sdkSessionId: null,
        usage: { inputTokens: 0, costUsd: 0 },
      });
      expect(service.get(session.id).status).toBe('running');
      expect(runner.runs).toHaveLength(1);
      expect(runner.last.options).toMatchObject({
        cwd: cloneOf(session),
        additionalDirectories: [],
        model: 'haiku',
        permissionMode: 'default',
        resume: null,
        sessionId: session.id,
      });
      expect(runner.last.sent).toEqual([
        { id: expect.any(String), text: 'Reply with pong' },
      ]);
      expect(eventTypes()).toEqual([
        'session.status',
        'user.message',
        'session.status',
      ]);
      expect(
        events
          .map(({ event }) => event)
          .filter((event) => event.type === 'session.status')
          .map((event) => event.type === 'session.status' && event.status),
      ).toEqual(['preparing', 'running']);
      expect(updates.at(-1)?.id).toBe(session.id);
    });

    it('derives a title from the first line of the prompt', async () => {
      expect(titleFromPrompt('  Fix the build\nDetails follow')).toBe(
        'Fix the build',
      );
      expect(titleFromPrompt('x'.repeat(100))).toHaveLength(80);
      const session = await startSession({ prompt: 'p', title: ' Mine ' });
      expect(session.title).toBe('Mine');
      expect(session.slug).toMatch(/^mine-/);
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
        'session.status',
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
      const logged = conversation(history.events);
      expect(logged.map((event) => event.type)).toEqual([
        'session.status',
        'user.message',
        'session.status',
        'assistant.text',
        'turn.result',
        'session.status',
        'context.usage',
      ]);
      // The two deltas between the running status and the text are gone.
      expect(logged[3].seq - logged[2].seq).toBe(3);
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
    it('keeps waiting when the process ends between turns, resumes on the next message', async () => {
      const session = await startSession();
      runner.last.emit(
        { type: 'system', subtype: 'init', session_id: 'sdk-1' },
        resultMessage(10, 0.01),
      );
      await flush();
      runner.last.close();
      await flush();
      expect(service.get(session.id).status).toBe('waiting');

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
      runner.last.emit(
        { type: 'system', subtype: 'init', session_id: 'sdk-1' },
        {
          type: 'assistant',
          uuid: 'a1',
          parent_tool_use_id: null,
          message: { id: 'm1', content: [{ type: 'text', text: 'pong' }] },
        },
      );
      await flush();
      await service.onModuleDestroy();
      expect(runner.last.closed).toBe(true);
      // A running turn was cut off: the session waits again.
      expect(new SessionRepository(db).require(session.id).status).toBe(
        'waiting',
      );

      transcripts.transcripts.set('sdk-1', [
        {
          type: 'user',
          // Claude Code uses the message ID as the entry's UUID.
          uuid: runner.last.sent[0].id,
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
      service = await createService();

      const history = await service.subscribe(session.id);
      expect(transcripts.reads).toEqual([
        { sdkSessionId: 'sdk-1', cwd: cloneOf(session) },
      ]);
      expect(history.session.status).toBe('waiting');
      // The preparation events follow the first message.
      expect(history.events.slice(1, 3)).toEqual([
        expect.objectContaining({ type: 'prepare.progress', step: 'fetch' }),
        expect.objectContaining({ type: 'prepare.progress', step: 'fetch' }),
      ]);
      expect(
        conversation(history.events).map((event, index) => ({
          ...event,
          seq: index + 1,
        })),
      ).toEqual([
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
        expect.objectContaining({
          seq: 3,
          type: 'notice',
          text: RESTART_NOTICE,
        }),
      ]);

      await service.send(session.id, { id: MSG_3, text: 'Once more' });
      await flush();
      expect(runner.last.options.resume).toBe('sdk-1');
      const seqs = (await service.subscribe(session.id)).events.map(
        (e) => e.seq,
      );
      expect(seqs).toEqual(seqs.map((_, index) => index + 1));
      expect(seqs).toHaveLength(history.events.length + 2);
      expect(transcripts.reads).toHaveLength(1);
    });

    it('marks sessions left running by a crash as waiting, with a notice', async () => {
      const session = await startSession();
      // Simulate a server that died without shutting down.
      const fresh = await createService();
      expect(fresh.get(session.id).status).toBe('waiting');
      const history = await fresh.subscribe(session.id);
      expect(history.events.at(-1)).toMatchObject({
        type: 'notice',
        text: RESTART_NOTICE,
      });
    });

    it('waits for processes to exit on shutdown, bounded', async () => {
      await startSession();
      const run = runner.last;
      run.close = () => {
        run.closed = true;
        // The process takes a moment to exit.
        setTimeout(() => run.output.close(), 30);
      };
      const started = Date.now();
      await service.onModuleDestroy();
      expect(Date.now() - started).toBeGreaterThanOrEqual(25);
      expect(run.closed).toBe(true);
    });

    it('ends a session on request and resumes it with a message', async () => {
      const session = await startSession();
      runner.last.emit(
        { type: 'system', subtype: 'init', session_id: 'sdk-1' },
        resultMessage(1, 0),
      );
      await flush();

      const ended = await service.end(session.id);
      await flush();
      expect(ended.status).toBe('finished');
      expect(runner.last.closed).toBe(true);
      expect(service.get(session.id).status).toBe('finished');
      expect(lastEvent('error')).toBeUndefined();

      await service.send(session.id, { id: MSG_2, text: 'Back again' });
      await flush();
      expect(service.get(session.id).status).toBe('running');
      expect(runner.last.options.resume).toBe('sdk-1');
    });

    it('fails a turn whose process ends without error', async () => {
      const session = await startSession();
      runner.last.stderr = ['fatal: something broke'];
      runner.last.close();
      await flush();
      expect(service.get(session.id)).toMatchObject({
        status: 'failed',
        lastError:
          'Claude Code ended unexpectedly while a turn was running: fatal: something broke',
      });
    });

    it('resumes a first start that died before Claude Code reported the ID', async () => {
      runner.failNextStart = new Error('boom');
      const session = await startSession();
      expect(service.get(session.id).sdkSessionId).toBeNull();

      transcripts.existing.add(session.id);
      await service.send(session.id, { id: MSG_2, text: 'again' });
      await flush();
      expect(runner.last.options).toMatchObject({
        resume: session.id,
        sessionId: null,
      });
    });

    it('waits for a starting process before interrupting', async () => {
      const session = await service.create({
        prompt: 'Reply with pong',
        repositories: [{ repositoryId: REPO_ID }],
      });
      await expect(service.interrupt(session.id)).rejects.toThrow(
        'still being prepared',
      );
      await waitFor(() => service.get(session.id).status === 'running');
      // The process is still starting.
      await service.interrupt(session.id);
      expect(runner.last.interrupted).toBe(1);
    });

    it('closes idle processes', async () => {
      config.sessionIdleTimeoutMs = 20;
      service = await createService();
      const session = await startSession();
      runner.last.emit(resultMessage(1, 0));
      await flush();
      expect(service.get(session.id).status).toBe('waiting');

      await new Promise((resolve) => setTimeout(resolve, 60));
      await flush();
      expect(runner.last.closed).toBe(true);
      // The process is an internal detail: the session still waits.
      expect(service.get(session.id).status).toBe('waiting');
      expect(lastEvent('error')).toBeUndefined();

      await service.send(session.id, { id: MSG_2, text: 'Later' });
      await flush();
      expect(runner.runs).toHaveLength(2);
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
      expect(service.get(session.id).status).toBe('waiting');
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
      expect(conversation(rebuilt.events).map((event) => event.type)).toEqual([
        'user.message',
        'tool.call',
        'permission.denied',
        'tool.result',
        'assistant.text',
        'turn.result',
        'context.usage',
      ]);
      expect(
        conversation(rebuilt.events).map((event) => event.at === null),
      ).toEqual([true, true, false, true, true, false, false]);
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
      expect(conversation(history.events).map((event) => event.type)).toEqual([
        // The first message never reached Claude Code: no transcript.
        'error',
      ]);
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
