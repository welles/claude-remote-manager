import type { AgentStartOptions } from './agent-runner';
import { AsyncQueue } from './async-queue';
import { buildQueryOptions } from './sdk-agent-runner';

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
    const options = buildQueryOptions(base, { claudeExecutable: null }, stderr);
    expect(options).toEqual({
      cwd: '/work',
      additionalDirectories: ['/extra'],
      permissionMode: 'default',
      canUseTool,
      sessionId: 'new-id',
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

  it('never bypasses permissions', () => {
    const options = buildQueryOptions(base, { claudeExecutable: null }, stderr);
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.permissionMode).not.toBe('bypassPermissions');
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
