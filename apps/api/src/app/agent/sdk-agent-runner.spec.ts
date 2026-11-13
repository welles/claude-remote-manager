import type { AgentStartOptions } from './agent-runner';
import { AsyncQueue } from './async-queue';
import { ProcessLauncher, type ProcessRole } from '../common/process-isolation';
import { buildQueryOptions, spawnAsSession } from './sdk-agent-runner';

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
