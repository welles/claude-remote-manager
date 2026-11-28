import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeEventTranslator,
  claudeCanUseTool,
  claudeModelUsage,
  claudePlanUsage,
  claudeRateLimit,
} from './claude-events';
import type { AgentApprovalCall } from './agent-events';

const message = (value: Record<string, unknown>) =>
  ({ uuid: 'u', session_id: 'sdk-1', ...value }) as unknown as SDKMessage;

describe('ClaudeEventTranslator', () => {
  it('turns Claude Code messages into agent events', () => {
    const translator = new ClaudeEventTranslator();
    expect(
      translator.translate(
        message({
          type: 'system',
          subtype: 'init',
          permissionMode: 'default',
          terminal_slash_commands: ['statusline'],
        }),
      ),
    ).toEqual([
      {
        type: 'started',
        engineSessionId: 'sdk-1',
        permissionMode: 'default',
        terminalCommands: ['statusline'],
      },
    ]);
    expect(
      translator.translate(
        message({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            utilization: 0.5,
            resetsAt: 1772380800,
          },
        }),
      ),
    ).toEqual([
      {
        type: 'rate-limit',
        limit: {
          window: 'five_hour',
          status: 'rejected',
          utilization: 50,
          resetsAt: '2026-03-01T16:00:00.000Z',
        },
      },
    ]);
    const limited = translator.translate(
      message({
        type: 'assistant',
        uuid: 'a1',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: {
          id: 'm1',
          content: [{ type: 'text', text: "You've hit your limit" }],
        },
      }),
    );
    expect(limited.map((event) => event.type)).toEqual([
      'activity',
      'limit-hit',
      'output',
    ]);
    expect(limited[2]).toMatchObject({
      anchor: 'a1',
      contextChanged: true,
      events: [
        expect.objectContaining({ type: 'assistant.text' }),
        expect.objectContaining({
          type: 'notice',
          text: 'API error: rate_limit',
        }),
      ],
    });
    expect(
      translator.translate(
        message({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Done',
          duration_ms: 10,
          num_turns: 1,
          queued_turn_count: 2,
          modelUsage: {
            haiku: {
              inputTokens: 1,
              outputTokens: 2,
              cacheCreationInputTokens: 3,
              cacheReadInputTokens: 4,
              costUSD: 0.5,
              webSearchRequests: 0,
              contextWindow: 1,
              maxOutputTokens: 1,
            },
          },
        }),
      ),
    ).toEqual([
      {
        type: 'result',
        subtype: 'success',
        isError: false,
        text: 'Done',
        errors: [],
        durationMs: 10,
        numTurns: 1,
        usage: {
          haiku: {
            inputTokens: 1,
            outputTokens: 2,
            cacheCreationInputTokens: 3,
            cacheReadInputTokens: 4,
            costUsd: 0.5,
          },
        },
        engineSessionId: 'sdk-1',
        queuedTurns: 2,
      },
    ]);
  });

  it('leaves subagent output without anchor or activity', () => {
    const events = new ClaudeEventTranslator().translate(
      message({
        type: 'assistant',
        uuid: 'a2',
        parent_tool_use_id: 'tool-1',
        message: { id: 'm2', content: [{ type: 'text', text: 'Sub' }] },
      }),
    );
    expect(events.map((event) => event.type)).toEqual(['output']);
    expect(events[0]).toMatchObject({ anchor: null });
  });
});

describe('Claude Code conversions', () => {
  it('reads plan usage and usage per model', () => {
    expect(
      claudePlanUsage({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12, resets_at: '2026-03-01T15:00:00Z' },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_oauth_apps: null,
          model_scoped: [
            { display_name: 'Fable', utilization: 5, resets_at: null },
          ],
        },
      } as never),
    ).toEqual({
      subscriptionType: 'max',
      windows: [
        {
          window: 'five_hour',
          label: null,
          utilization: 12,
          resetsAt: '2026-03-01T15:00:00.000Z',
        },
        {
          window: 'model:Fable',
          label: 'Week (Fable)',
          utilization: 5,
          resetsAt: null,
        },
      ],
    });
    expect(
      claudePlanUsage({
        subscription_type: 'pro',
        rate_limits_available: false,
        rate_limits: null,
      } as never),
    ).toEqual({ subscriptionType: 'pro', windows: null });
    expect(claudeRateLimit({ status: 'allowed' } as never)).toEqual({
      window: null,
      status: 'allowed',
      utilization: null,
      resetsAt: null,
    });
    expect(claudeModelUsage({})).toEqual({});
  });

  it('asks the neutral approver and answers Claude Code', async () => {
    const calls: AgentApprovalCall[] = [];
    const canUseTool = claudeCanUseTool(async (call) => {
      calls.push(call);
      return call.toolName === 'Bash'
        ? {
            behavior: 'allow',
            updatedPermissions: [
              ...call.suggestions,
              { type: 'other', raw: { type: 'replaceRules' } },
            ],
          }
        : { behavior: 'deny', message: 'no', interrupt: true };
    });
    const signal = new AbortController().signal;
    await expect(
      canUseTool(
        'Bash',
        { command: 'npm test' },
        {
          signal,
          toolUseID: 't1',
          requestId: 'r1',
          suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        },
      ),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      toolName: 'Bash',
      toolUseId: 't1',
      title: null,
      agentId: null,
      mcpServer: null,
      suppressAlwaysAllow: false,
    });
    await expect(
      canUseTool('Edit', {}, { signal, toolUseID: 't2', requestId: 'r2' }),
    ).resolves.toEqual({ behavior: 'deny', message: 'no', interrupt: true });
  });
});
