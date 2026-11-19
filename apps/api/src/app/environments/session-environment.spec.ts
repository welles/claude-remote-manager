import { SessionEventRepository } from '../sessions/session-event.repository';
import { existsSync, readFileSync } from 'node:fs';
import { WorkspaceHarness } from '../workspaces/testing/workspace-harness';
import { flush, waitFor } from '../sessions/testing/fake-agent';

describe('sessions with an environment', () => {
  let harness: WorkspaceHarness;

  beforeEach(async () => {
    harness = new WorkspaceHarness();
    await harness.start();
  });
  afterEach(() => harness.close());

  const SECRET = 'sk_live_abcdef123';

  const environment = (setupScript: string | null = 'echo "env $API_TOKEN"') =>
    harness.environments.create({
      name: 'Payments',
      instructions: 'Use the sandbox.',
      setupScript,
      variables: [
        { name: 'API_TOKEN', secret: true, value: SECRET },
        { name: 'API_URL', secret: false, value: 'https://sandbox.test' },
      ],
      files: [
        {
          variable: 'SERVICE_ACCOUNT',
          fileName: 'account.json',
          secret: true,
          content: '{"key":"FILE-SECRET-1"}',
        },
      ],
    });

  const outputs = (sessionId: string) =>
    harness.events
      .filter((envelope) => envelope.sessionId === sessionId)
      .map((envelope) => envelope.event)
      .filter((event) => event.type === 'setup.output')
      .map((event) => (event as { text: string }).text)
      .join('');

  it('gives processes and setup scripts its variables, files and instructions, and masks its secrets', async () => {
    const repository = await harness.addRepository(
      'alice',
      'app',
      'echo "repo $API_TOKEN $API_URL"; cat "$SERVICE_ACCOUNT"',
    );
    const env = environment();
    const session = await harness.service.create({
      prompt: 'Work',
      repositories: [{ repositoryId: repository.id }],
      environmentId: env.id,
    });
    expect(session.environment).toEqual({
      id: env.id,
      name: 'Payments',
      setupStatus: 'pending',
    });
    await harness.prepared(session.id);

    // Both scripts ran with the environment; their output is masked.
    const output = outputs(session.id);
    expect(output).toContain('repo *** https://sandbox.test');
    expect(output).toContain('env ***');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('FILE-SECRET-1');
    expect(harness.sessions.require(session.id).environmentSetupStatus).toBe(
      'succeeded',
    );

    const options = harness.runner.last.options;
    expect(options.env).toMatchObject({
      API_TOKEN: SECRET,
      API_URL: 'https://sandbox.test',
    });
    const file = options.env?.['SERVICE_ACCOUNT'] as string;
    expect(readFileSync(file, 'utf8')).toBe('{"key":"FILE-SECRET-1"}');
    expect(file.startsWith(harness.config.environmentFilesDir)).toBe(true);
    expect(options.instructions).toContain('# Environment "Payments"');
    expect(options.instructions).toContain('Use the sandbox.');
    expect(options.instructions).toContain('`API_TOKEN`');
    expect(options.instructions).not.toContain(SECRET);

    // What Claude prints is masked before it is stored or sent.
    harness.runner.last.emit({
      type: 'assistant',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: `The token is ${SECRET}.` }],
      },
      parent_tool_use_id: null,
    } as never);
    await flush();
    const texts = JSON.stringify(
      harness.events.filter((envelope) => envelope.sessionId === session.id),
    );
    expect(texts).toContain('The token is ***.');
    expect(texts).not.toContain(SECRET);

    // Streamed text is masked although the secret comes in pieces.
    const delta = (text: string) => ({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
      parent_tool_use_id: null,
      uuid: 'u',
      session_id: 's',
    });
    harness.runner.last.emit(
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm2' } },
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
      } as never,
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's',
      } as never,
      delta('Key: sk_live_') as never,
      delta('abcdef123 done, more words follow') as never,
    );
    await flush();
    const deltas = harness.events
      .filter((envelope) => envelope.sessionId === session.id)
      .map((envelope) => envelope.event)
      .filter((event) => event.type === 'assistant.delta');
    expect(deltas.length).toBeGreaterThan(0);
    const streamed = deltas
      .map((event) => (event as { text: string }).text)
      .join('');
    expect(streamed).toContain('Key: ***');
    expect(streamed).not.toContain('sk_live_');

    // The files go with the process.
    await harness.service.end(session.id);
    await waitFor(() => !existsSync(file));
  });

  it('reruns a failed setup script of the environment', async () => {
    const env = environment('exit 3');
    const session = await harness.service.create({
      prompt: 'Work',
      scratch: true,
      environmentId: env.id,
    });
    await harness.prepared(session.id);
    expect(harness.sessions.require(session.id).environmentSetupStatus).toBe(
      'failed',
    );
    expect(harness.runner.runs).toHaveLength(0);
    harness.environments.update(env.id, {
      ...env,
      setupScript: 'true',
      variables: env.variables.map(({ id, name, secret, value }) => ({
        id,
        name,
        secret,
        ...(value === null ? {} : { value }),
      })),
      files: env.files.map(({ id, variable, fileName, secret }) => ({
        id,
        variable,
        fileName,
        secret,
      })),
    });
    await harness.service.rerunSetup(session.id);
    await harness.prepared(session.id);
    expect(harness.sessions.require(session.id).environmentSetupStatus).toBe(
      'succeeded',
    );
    expect(harness.runner.runs).toHaveLength(1);
  });

  it('masks secrets in the error of a failed process', async () => {
    const env = environment(null);
    const session = await harness.service.create({
      prompt: 'Work',
      scratch: true,
      environmentId: env.id,
    });
    await harness.prepared(session.id);
    harness.runner.last.crash(new Error(`crashed with ${SECRET}`));
    await waitFor(
      () => harness.sessions.require(session.id).status === 'failed',
    );
    const lastError = harness.sessions.require(session.id).lastError ?? '';
    expect(lastError).toContain('crashed with ***');
    expect(lastError).not.toContain(SECRET);
  });

  it("runs the repositories' scripts when the environment cannot be prepared", async () => {
    const repository = await harness.addRepository(
      'alice',
      'app',
      'echo "repo [$API_TOKEN]"',
    );
    const env = environment('true');
    // As if the key had changed: the secrets cannot be decrypted.
    jest.spyOn(harness.environments, 'forLaunch').mockImplementation(() => {
      throw new Error('could not be decrypted');
    });
    const session = await harness.service.create({
      prompt: 'Work',
      repositories: [{ repositoryId: repository.id }],
      environmentId: env.id,
    });
    await harness.prepared(session.id);
    expect(outputs(session.id)).toContain('repo []');
    const record = harness.sessions.require(session.id);
    expect(record.directories[0].setupStatus).toBe('succeeded');
    expect(record.environmentSetupStatus).toBe('failed');
    expect(harness.service.get(session.id).environment?.setupStatus).toBe(
      'failed',
    );
  });

  it('masks a secret split across chunks of setup output', async () => {
    // Prints the token in two parts with a pause, so they come in two chunks.
    const env = environment(
      'printf "a %s" "${API_TOKEN:0:8}"; sleep 0.4; printf "%s b\\n" "${API_TOKEN:8}"',
    );
    const session = await harness.service.create({
      prompt: 'Work',
      scratch: true,
      environmentId: env.id,
    });
    await harness.prepared(session.id);
    const events = harness.events
      .filter((envelope) => envelope.sessionId === session.id)
      .map((envelope) => envelope.event);
    const output = outputs(session.id);
    expect(output).toContain('a *** b');
    expect(output).not.toContain(SECRET.slice(0, 8));
    expect(output).not.toContain(SECRET.slice(8));
    const stored = JSON.stringify(
      new SessionEventRepository(harness.db).list(session.id),
    );
    expect(stored).toContain('a *** b');
    expect(stored).not.toContain(SECRET.slice(8));
    const result = events.find(
      (event) => event.type === 'setup.result' && event.state === 'succeeded',
    ) as { outputTail: string | null } | undefined;
    expect(result?.outputTail ?? '').not.toContain(SECRET.slice(8));
  });

  it('rejects an unknown environment', async () => {
    await expect(
      harness.service.create({
        prompt: 'Work',
        scratch: true,
        environmentId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow('not found');
  });
});
