import { FakeAgentRunner } from './testing/fake-agent';
import {
  PROBE_TIMEOUT_MS,
  SlashCommandsService,
  USER_COMMANDS_CACHE_MS,
  USER_COMMANDS_RETRY_MS,
  uniqueCommands,
} from './slash-commands.service';

const command = (name: string, extra: object = {}) => ({
  name,
  description: name,
  argumentHint: '',
  aliases: [] as string[],
  builtin: false,
  ...extra,
});

describe('SlashCommandsService', () => {
  let runner: FakeAgentRunner;
  let service: SlashCommandsService;
  let now: number;

  beforeEach(() => {
    runner = new FakeAgentRunner();
    service = new SlashCommandsService(runner);
    now = 1_000;
    service.now = () => now;
  });

  const names = async (sessionId: string) =>
    (await service.forSession(sessionId)).commands.map((c) => c.name);

  it('caches the probe, shares it, and asks again after the cache time', async () => {
    runner.probeCommands = () => [command('review'), command('doctor')];
    const [a, b] = await Promise.all([names('s1'), names('s2')]);
    // Terminal-bound commands are left out.
    expect(a).toEqual(['review']);
    expect(b).toEqual(['review']);
    expect(runner.probes).toBe(1);
    await names('s1');
    expect(runner.probes).toBe(1);
    now += USER_COMMANDS_CACHE_MS + 1;
    await names('s1');
    expect(runner.probes).toBe(2);
  });

  it('keeps the last list when a probe fails, and retries later', async () => {
    runner.probeCommands = () => [command('review')];
    await names('s1');
    now += USER_COMMANDS_CACHE_MS + 1;
    runner.probeCommands = () => {
      throw new Error('down');
    };
    expect(await names('s1')).toEqual(['review']);
    await names('s1');
    expect(runner.probes).toBe(2);
    now += USER_COMMANDS_RETRY_MS + 1;
    runner.probeCommands = () => [command('fresh')];
    expect(await names('s1')).toEqual(['fresh']);
  });

  it('gives up on a probe that does not answer', async () => {
    jest.useFakeTimers();
    try {
      runner.probe = (task) =>
        task({
          supportedModels: async () => [],
          planUsage: () => new Promise(() => undefined),
          supportedCommands: () => new Promise(() => undefined),
        });
      const listed = service.forSession('s1');
      await jest.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
      await expect(listed).resolves.toEqual({ commands: [], source: 'user' });
    } finally {
      jest.useRealTimers();
    }
  });

  it("prefers a session's own list, terminal names it learned and forgets it", async () => {
    runner.probeCommands = () => [command('review')];
    service.remember('s1', [command('deploy'), command('statusline')]);
    service.terminalCommands(['statusline']);
    expect(await service.forSession('s1')).toMatchObject({ source: 'session' });
    expect(await names('s1')).toEqual(['deploy']);
    service.forget('s1');
    expect(await names('s1')).toEqual(['review']);
  });
});

describe('uniqueCommands', () => {
  it("keeps one row per name, Claude Code's own where marked", () => {
    const rows = uniqueCommands([
      { ...command('context'), aliases: [], builtin: false },
      { ...command('context'), aliases: [], builtin: true },
      { ...command('deploy'), aliases: [], builtin: false },
      {
        ...command('deploy', { description: 'second' }),
        aliases: [],
        builtin: false,
      },
    ]);
    expect(rows.map((row) => [row.name, row.builtin, row.description])).toEqual(
      [
        ['context', true, 'context'],
        ['deploy', false, 'deploy'],
      ],
    );
  });
});
