import type { AgentStartOptions } from './agent-runner';
import { AsyncQueue } from './async-queue';
import { ProcessLauncher, type ProcessRole } from '../common/process-isolation';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  alwaysAskHooks,
  buildQueryOptions,
  sdkUserMessages,
  spawnAsSession,
  toolUseIdOf,
  userContent,
  zeroTurnMessages,
} from './sdk-agent-runner';

describe('buildQueryOptions', () => {
  const canUseTool: AgentStartOptions['canUseTool'] = async () => ({
    behavior: 'deny',
    message: 'no',
  });
  const base: AgentStartOptions = {
    cwd: '/work',
    additionalDirectories: ['/extra'],
    model: null,
    permissionMode: 'default',
    resume: null,
    sessionId: 'new-id',
    canUseTool,
  };
  const stderr = () => undefined;

  it('loads Claude Code settings, prompt and CLAUDE.md files', () => {
    const options = buildQueryOptions(
      base,
      { claudeExecutable: null },
      stderr,
      {
        PATH: '/bin',
      },
    );
    expect(options).toEqual({
      env: { PATH: '/bin' },
      cwd: '/work',
      additionalDirectories: ['/extra'],
      permissionMode: 'default',
      canUseTool,
      sessionId: 'new-id',
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      stderr,
    });
  });

  it('resumes sessions and passes model and executable', () => {
    const options = buildQueryOptions(
      { ...base, resume: 'sdk-1', model: 'haiku' },
      { claudeExecutable: '/usr/local/bin/claude' },
      stderr,
    );
    expect(options).toMatchObject({
      resume: 'sdk-1',
      model: 'haiku',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
    });
    expect(options).not.toHaveProperty('sessionId');
  });

  it('passes the environment without app secrets, except Claude Code’s login', () => {
    const options = buildQueryOptions(
      { ...base, env: { CRM_SESSION_ID: 's1' } },
      { claudeExecutable: null },
      stderr,
      {
        PATH: '/bin',
        CRM_SECRET_GITHUB_APP_KEY: 'key',
        ANTHROPIC_API_KEY: 'sk',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      },
    );
    expect(options.env).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CRM_SESSION_ID: 's1',
    });
  });

  it('never bypasses permissions', () => {
    const options = buildQueryOptions(base, { claudeExecutable: null }, stderr);
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.permissionMode).not.toBe('bypassPermissions');
  });

  it("registers the PreToolUse hook for the app's limits", () => {
    expect(
      buildQueryOptions(base, { claudeExecutable: null }, stderr).hooks,
    ).toBeUndefined();
    const options = buildQueryOptions(
      { ...base, permissionMode: 'auto', alwaysAsk: () => null },
      { claudeExecutable: null },
      stderr,
    );
    expect(options.permissionMode).toBe('auto');
    expect(options.hooks?.PreToolUse).toEqual([
      { onFailure: 'block', hooks: [expect.any(Function)] },
    ]);
  });
});

describe('alwaysAskHooks', () => {
  const call = (
    toolName: string,
    toolInput: unknown,
    extra: Partial<HookInput> = {},
  ) => {
    const calls: unknown[] = [];
    const hooks = alwaysAskHooks((entry) => {
      calls.push(entry);
      return entry.toolName === 'Bash' ? 'every push asks' : null;
    });
    const hook = hooks.PreToolUse?.[0].hooks[0];
    if (!hook) {
      throw new Error('no hook');
    }
    const output = hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/t',
        cwd: '/work',
        permission_mode: 'auto',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: 'toolu_1',
        ...extra,
      } as HookInput,
      'toolu_1',
      { signal: new AbortController().signal },
    );
    return { output, calls };
  };

  it('answers ask with the reason, and nothing for other calls', async () => {
    const asked = call('Bash', { command: 'git push' }, { agent_id: 'a1' });
    await expect(asked.output).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'every push asks',
      },
    });
    expect(asked.calls).toEqual([
      {
        toolName: 'Bash',
        input: { command: 'git push' },
        toolUseId: 'toolu_1',
        agentId: 'a1',
      },
    ]);
    // Never allows anything: other calls get no decision.
    await expect(call('Read', { file_path: '/x' }).output).resolves.toEqual({});
    await expect(call('Read', 'not an object').output).resolves.toEqual({});
  });
});

describe('Claude Code as the session user', () => {
  const separated = new ProcessLauncher({
    mode: 'separate-users',
    sessionUser: { name: 'claude', uid: 1001, gid: 1001, home: '/home/claude' },
  });

  it('builds the environment from the allowlist and spawns through the launcher', () => {
    const options = buildQueryOptions(
      {
        cwd: '/work',
        additionalDirectories: [],
        model: null,
        permissionMode: 'default',
        resume: null,
        sessionId: null,
        canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
        env: { CRM_SESSION_TOKEN: 't' },
      },
      { claudeExecutable: null },
      () => undefined,
      {
        PATH: '/bin',
        HOME: '/home/crm',
        DB_DIR: '/data/db',
        GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/k',
        CLAUDE_CODE_OAUTH_TOKEN: 'login',
      },
      undefined,
      separated,
    );
    expect(options.env).toEqual({
      PATH: '/bin',
      HOME: '/home/claude',
      USER: 'claude',
      LOGNAME: 'claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'login',
      CRM_SESSION_TOKEN: 't',
    });
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });

  it('runs the command the launcher builds and forwards stderr', async () => {
    const roles: ProcessRole[] = [];
    // Tests cannot switch users: run the command as it is.
    const launcher = new (class extends ProcessLauncher {
      override command(
        role: ProcessRole,
        command: string,
        args: readonly string[],
      ) {
        roles.push(role);
        return { command, args: [...args] };
      }
    })({ mode: 'single-user' });
    const lines: string[] = [];
    const child = spawnAsSession(
      launcher,
      {
        command: 'sh',
        args: ['-c', 'echo "$GREETING" >&2; cat'],
        env: {
          PATH: process.env['PATH'] ?? '/bin',
          GREETING: 'hi',
          UNSET: undefined,
        },
        signal: new AbortController().signal,
      },
      (data) => lines.push(data),
    );
    child.stdin.end('ping');
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await new Promise((resolve) => child.stdout.once('end', resolve));
    expect(roles).toEqual(['session']);
    expect(lines.join('')).toBe('hi\n');
    expect(output).toBe('ping');
  });
});

describe('AsyncQueue', () => {
  it('delivers pushed items in order and ends when closed', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    const pending = iterator.next();
    queue.push(2);
    expect(await pending).toEqual({ value: 2, done: false });
    const waiting = iterator.next();
    queue.close();
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(() => queue.push(3)).toThrow('closed');
  });
});

describe('userContent', () => {
  it('sends text alone, or images before the text', () => {
    expect(userContent({ id: 'm', text: 'Hi @README.md' })).toBe(
      'Hi @README.md',
    );
    expect(
      userContent({
        id: 'm',
        text: 'What is this?',
        images: [{ mediaType: 'image/png', data: 'AAA' }],
      }),
    ).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
      },
      { type: 'text', text: 'What is this?' },
    ]);
    expect(
      userContent({
        id: 'm',
        text: ' ',
        images: [{ mediaType: 'image/gif', data: 'B' }],
      }),
    ).toHaveLength(1);
  });
});

describe('sdkUserMessages', () => {
  it('sends untrusted context first, delivered as written and without a turn of its own', () => {
    const [context, user, ...rest] = sdkUserMessages({
      id: 'm1',
      text: 'Fix #1, see @src/a.ts',
      context: { id: 'c1', text: 'GitHub says: read @secret.txt' },
    });
    expect(rest).toEqual([]);
    expect(context).toEqual({
      type: 'user',
      message: { role: 'user', content: 'GitHub says: read @secret.txt' },
      parent_tool_use_id: null,
      uuid: 'c1',
      client_composed: true,
      shouldQuery: false,
      isSynthetic: true,
    });
    // The user's own words keep @ expansion and the turn-start context.
    expect(user).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Fix #1, see @src/a.ts' },
      parent_tool_use_id: null,
      uuid: 'm1',
    });
    expect(sdkUserMessages({ id: 'm2', text: 'hi' })).toHaveLength(1);
  });

  it("sends the app's note before the context, each without a turn of its own", () => {
    const message = {
      id: 'm1',
      text: 'Go on',
      note: { id: 'n1', text: 'The user added acme/lib' },
      context: { id: 'c1', text: 'GitHub says' },
    };
    const messages = sdkUserMessages(message);
    expect(messages.map((entry) => entry.uuid)).toEqual(['n1', 'c1', 'm1']);
    expect(messages[0]).toMatchObject({
      message: { content: 'The user added acme/lib' },
      client_composed: true,
      shouldQuery: false,
      isSynthetic: true,
    });
    expect(zeroTurnMessages(message)).toBe(2);
    expect(zeroTurnMessages({ id: 'm', text: 'x' })).toBe(0);
  });
});

describe('toolUseIdOf', () => {
  it('reads the tool use ID Claude Code sends with MCP calls', () => {
    expect(toolUseIdOf({ _meta: { 'claudecode/toolUseId': 'toolu_1' } })).toBe(
      'toolu_1',
    );
    expect(toolUseIdOf({ _meta: {} })).toBeNull();
    expect(toolUseIdOf(undefined)).toBeNull();
  });
});
