import { BadRequestException } from '@nestjs/common';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ToolApprovalRequest } from '../agent/tool-approval';
import { CREATE_PULL_REQUEST_TOOL_NAME } from './app-tools';
import {
  cancellation,
  describeRequest,
  DENIED_STOP_MESSAGE,
  parseQuestions,
  resolveResponse,
  ruleString,
  sessionAllowOffer,
  sessionAllows,
  unresolvedRequests,
} from './permission-requests';
import type { StoredEvent } from './session-event.repository';

const request = (
  toolName: string,
  input: Record<string, unknown>,
  extra: Partial<ToolApprovalRequest> = {},
): ToolApprovalRequest => ({
  sessionId: 's',
  toolName,
  input,
  toolUseId: 't',
  title: null,
  description: null,
  displayName: null,
  decisionReason: null,
  blockedPath: null,
  agentId: null,
  mcpServer: null,
  gitPushes: [],
  pullRequest: null,
  suggestions: [],
  suppressAlwaysAllow: false,
  signal: new AbortController().signal,
  onRequest: () => undefined,
  onResolve: () => undefined,
  ...extra,
});

const allowRules = (
  ...rules: { toolName: string; ruleContent?: string }[]
): PermissionUpdate => ({
  type: 'addRules',
  behavior: 'allow',
  destination: 'localSettings',
  rules,
});

describe('sessionAllowOffer', () => {
  it('turns suggestions into session-only updates, without mode switches', () => {
    const offer = sessionAllowOffer(
      request(
        'Bash',
        { command: 'npm test' },
        {
          suggestions: [
            allowRules({ toolName: 'Bash', ruleContent: 'npm test:*' }),
            {
              type: 'addDirectories',
              directories: ['/data/other'],
              destination: 'userSettings',
            },
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          ],
        },
      ),
    );
    expect(offer?.offer).toEqual({
      rules: ['Bash(npm test:*)'],
      directories: ['/data/other'],
      mode: null,
    });
    // Never a settings file, never a mode switch.
    expect(offer?.updates.map((update) => update.destination)).toEqual([
      'session',
      'session',
    ]);
    expect(offer?.updates.map((update) => update.type)).toEqual([
      'addRules',
      'addDirectories',
    ]);
  });

  it('never offers a permission mode switch for the session', () => {
    // Claude Code suggests "accept edits" for file changes; the user changes
    // the mode only through the mode control.
    expect(
      sessionAllowOffer(
        request(
          'Edit',
          { file_path: '/work/a.ts' },
          {
            suggestions: [
              { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
            ],
          },
        ),
      ),
    ).toBeNull();
  });

  it('drops what must keep asking or is too broad', () => {
    const offer = (
      toolName: string,
      input: Record<string, unknown>,
      suggestions: PermissionUpdate[],
      extra: Partial<ToolApprovalRequest> = {},
    ) => sessionAllowOffer(request(toolName, input, { suggestions, ...extra }));
    const pushRules = allowRules(
      { toolName: 'Bash', ruleContent: 'git push:*' },
      { toolName: 'Bash', ruleContent: 'git:*' },
      { toolName: 'Bash', ruleContent: 'git *' },
      { toolName: 'Bash' },
      { toolName: 'Bash', ruleContent: '*' },
      { toolName: 'mcp__crm__create_pull_request' },
    );
    // Pushes and the app's tools like any other; never all Bash commands.
    expect(offer('Bash', { command: 'ls' }, [pushRules])?.offer.rules).toEqual([
      'Bash(git push:*)',
      'Bash(git:*)',
      'Bash(git *)',
      'mcp__crm__create_pull_request',
    ]);
    const any = [allowRules({ toolName: 'Bash', ruleContent: 'ls:*' })];
    expect(
      offer('Bash', { command: 'git push origin HEAD' }, any),
    ).not.toBeNull();
    expect(offer(CREATE_PULL_REQUEST_TOOL_NAME, {}, any)).not.toBeNull();
    // Questions and plans: never.
    expect(offer('AskUserQuestion', {}, any)).toBeNull();
    expect(offer('ExitPlanMode', {}, any)).toBeNull();
    // Claude Code says not to offer it.
    expect(
      offer('Bash', { command: 'ls' }, any, { suppressAlwaysAllow: true }),
    ).toBeNull();
    // Bypass and deny suggestions are not offered.
    expect(
      offer('Edit', {}, [
        {
          type: 'setMode',
          mode: 'bypassPermissions',
          destination: 'session',
        },
        {
          type: 'addRules',
          behavior: 'deny',
          destination: 'session',
          rules: [{ toolName: 'Edit' }],
        },
      ]),
    ).toBeNull();
    // Without suggestions there is nothing to offer.
    expect(offer('Bash', { command: 'ls' }, [])).toBeNull();
  });

  it('writes rules like Claude Code', () => {
    expect(ruleString({ toolName: 'Read' })).toBe('Read');
    expect(ruleString({ toolName: 'Bash', ruleContent: 'ls:*' })).toBe(
      'Bash(ls:*)',
    );
  });
});

describe('describeRequest', () => {
  it('classifies questions and plans', () => {
    const questions = [
      {
        question: 'Which?',
        header: 'Pick',
        options: [{ label: 'A', description: 'a', preview: '`a`' }],
        multiSelect: false,
      },
    ];
    expect(
      describeRequest('r', request('AskUserQuestion', { questions }), null),
    ).toMatchObject({ kind: 'question', questions, plan: null });
    expect(
      describeRequest('r', request('ExitPlanMode', { plan: '# Plan' }), null),
    ).toMatchObject({ kind: 'plan', plan: '# Plan', questions: null });
    expect(
      describeRequest('r', request('Bash', { command: 'ls' }), null),
    ).toMatchObject({ kind: 'tool', questions: null, plan: null });
    expect(parseQuestions({ questions: 'nope' })).toBeNull();
    expect(
      parseQuestions({ questions: [{ question: 'Q', options: [{}] }] }),
    ).toEqual([
      {
        question: 'Q',
        header: '',
        options: [{ label: '', description: '', preview: null }],
        multiSelect: false,
      },
    ]);
  });
});

describe('resolveResponse', () => {
  const event = (toolName: string, input: Record<string, unknown>) =>
    describeRequest('r', request(toolName, input), null);

  it('allows once and denies with or without a message', () => {
    const tool = event('Bash', { command: 'ls' });
    expect(
      resolveResponse(tool, { command: 'ls' }, [], { decision: 'allow' }),
    ).toMatchObject({
      result: { behavior: 'allow', updatedInput: { command: 'ls' } },
      resolution: { decision: 'allow', scope: 'once', cause: 'user' },
    });
    expect(
      resolveResponse(tool, {}, [], { decision: 'deny', message: ' later ' })
        .result,
    ).toEqual({
      behavior: 'deny',
      message: 'The user denied this tool use (it was not run) and said: later',
    });
    expect(resolveResponse(tool, {}, [], { decision: 'deny' }).result).toEqual({
      behavior: 'deny',
      message: DENIED_STOP_MESSAGE,
      interrupt: true,
    });
  });

  it('validates the answer', () => {
    const tool = event('Bash', { command: 'ls' });
    for (const body of [
      null,
      'allow',
      { decision: 'yes' },
      { decision: 'allow', scope: 'forever' },
      { decision: 'allow', scope: 'session' },
      { decision: 'deny', message: 'x'.repeat(10_001) },
    ]) {
      expect(() => resolveResponse(tool, {}, [], body)).toThrow(
        BadRequestException,
      );
    }
    const question = event('AskUserQuestion', {
      questions: [{ question: 'Q?', header: 'Q', options: [] }],
    });
    for (const answers of [
      undefined,
      {},
      { 'Q?': '' },
      { 'Q?': 3 },
      { 'Q?': 'a', 'Other?': 'b' },
    ]) {
      expect(() =>
        resolveResponse(question, {}, [], { decision: 'allow', answers }),
      ).toThrow(BadRequestException);
    }
    expect(() =>
      resolveResponse(event('ExitPlanMode', {}), {}, [], {
        decision: 'allow',
        mode: 'bypassPermissions',
      }),
    ).toThrow(BadRequestException);
  });

  it('approves plans into the default mode unless chosen otherwise', () => {
    expect(
      resolveResponse(event('ExitPlanMode', { plan: 'p' }), { plan: 'p' }, [], {
        decision: 'allow',
      }),
    ).toMatchObject({
      result: {
        updatedPermissions: [
          { type: 'setMode', mode: 'default', destination: 'session' },
        ],
      },
      resolution: { mode: 'default' },
    });
  });

  it('cancels with a reason for Claude', () => {
    expect(cancellation(event('Bash', {}), 'process_exit')).toMatchObject({
      result: { behavior: 'deny', message: expect.stringContaining('ended') },
      resolution: { decision: 'deny', cause: 'process_exit' },
    });
  });
});

describe('stored decisions', () => {
  const stored = (event: unknown): StoredEvent => ({
    event: event as StoredEvent['event'],
    anchor: { uuid: null, userId: null },
    createdAt: new Date(),
  });

  it('collects what was allowed for the session and what stayed open', () => {
    const events = [
      stored({ type: 'permission.request', requestId: 'a', toolUseId: 't' }),
      stored({ type: 'permission.request', requestId: 'b', toolUseId: 'u' }),
      stored({
        type: 'permission.resolved',
        requestId: 'a',
        scope: 'session',
        sessionAllow: {
          rules: ['Bash(ls:*)'],
          directories: ['/x'],
          mode: null,
        },
      }),
      stored({
        type: 'permission.resolved',
        requestId: 'c',
        scope: 'once',
        sessionAllow: null,
      }),
    ];
    expect(sessionAllows(events)).toEqual({
      rules: ['Bash(ls:*)'],
      directories: ['/x'],
    });
    expect(unresolvedRequests(events).map((event) => event.requestId)).toEqual([
      'b',
    ]);
  });
});
