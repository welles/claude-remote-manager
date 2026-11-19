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
    expect(session.environment).toEqual({ id: env.id, name: 'Payments' });
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
