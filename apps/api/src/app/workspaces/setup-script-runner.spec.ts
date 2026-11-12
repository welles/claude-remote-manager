import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SETUP_OUTPUT, SetupScriptRunner } from './setup-script-runner';

describe('SetupScriptRunner', () => {
  let dir: string;
  const runner = new SetupScriptRunner();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-setup-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (
    script: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) => {
    const output: string[] = [];
    const result = await runner.run({
      script,
      cwd: dir,
      env: { CRM_REPOSITORY: 'acme/tool' },
      timeoutMs: options.timeoutMs ?? 10_000,
      signal: options.signal,
      onOutput: (text) => output.push(text),
    });
    return { result, output: output.join('') };
  };

  it('runs in the worktree with the session variables and streams output', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'secret';
    process.env['CRM_SECRET_TEST_KEY'] = 'registered by prefix';
    try {
      const { result, output } = await run(
        'pwd; echo "$CRM_REPOSITORY"; echo "token=${CLAUDE_CODE_OAUTH_TOKEN:-}${CRM_SECRET_TEST_KEY:-}"; echo err >&2',
      );
      expect(result).toMatchObject({
        state: 'succeeded',
        exitCode: 0,
        message: null,
        outputTail: null,
      });
      expect(output).toBe(`${dir}\nacme/tool\ntoken=\nerr\n`);
    } finally {
      delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      delete process.env['CRM_SECRET_TEST_KEY'];
    }
  });

  it('stops at the first failing command', async () => {
    const { result, output } = await run('echo one; false; echo two');
    expect(result).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(output).toBe('one\n');

    const pipe = await run('false | true');
    expect(pipe.result.state).toBe('failed');
  });

  it('stops the script and its children after the timeout', async () => {
    const started = Date.now();
    const { result } = await run('sleep 30 & sleep 30', { timeoutMs: 300 });
    expect(result).toMatchObject({
      state: 'timed_out',
      signal: 'SIGTERM',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not wait for background processes that keep the output open', async () => {
    const started = Date.now();
    const { result } = await run('sleep 30 & echo started');
    expect(result.state).toBe('succeeded');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('can be stopped', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const { result } = await run('sleep 30', { signal: controller.signal });
    expect(result).toMatchObject({
      state: 'failed',
      message: 'Stopped because the session was ended',
    });
  });

  it('caps the forwarded output and keeps the tail', async () => {
    const { result, output } = await run(
      `head -c ${MAX_SETUP_OUTPUT + 50_000} /dev/zero | tr '\\0' 'x'; echo; echo the-end`,
    );
    expect(result.state).toBe('succeeded');
    expect(output.length).toBe(MAX_SETUP_OUTPUT);
    expect(result.outputTail).toMatch(/the-end\n$/);
  });
});
