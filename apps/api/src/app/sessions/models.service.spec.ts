import {
  FALLBACK_MODELS,
  MODELS_CACHE_MS,
  ModelsService,
} from './models.service';
import { FakeAgentRunner } from './testing/fake-agent';

describe('ModelsService', () => {
  it('offers the models Claude Code reports, cached', async () => {
    const runner = new FakeAgentRunner();
    runner.probeModels = () => [
      {
        value: 'default',
        resolvedModel: 'claude-x-1',
        displayName: 'Default (recommended)',
        description: 'X 1',
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-9',
        displayName: 'Haiku 9',
        description: 'Fast',
      },
    ];
    const service = new ModelsService(runner);
    let now = 1_000;
    service.now = () => now;
    const response = await service.list();
    expect(response).toEqual({
      source: 'claude-code',
      updatedAt: new Date(1_000).toISOString(),
      models: [
        {
          value: null,
          label: 'Default (recommended)',
          description: 'X 1',
          resolvedModel: 'claude-x-1',
        },
        {
          value: 'haiku',
          label: 'Haiku 9',
          description: 'Fast',
          resolvedModel: 'claude-haiku-9',
        },
      ],
    });
    await service.list();
    expect(runner.probes).toBe(1);
    now += MODELS_CACHE_MS + 1;
    await service.list();
    expect(runner.probes).toBe(2);
  });

  it('falls back to the aliases when Claude Code cannot be asked', async () => {
    const runner = new FakeAgentRunner();
    runner.probeModels = () => {
      throw new Error('not logged in');
    };
    const response = await new ModelsService(runner).list();
    expect(response).toEqual({
      source: 'fallback',
      updatedAt: null,
      models: FALLBACK_MODELS,
    });
    expect(response.models.map((model) => model.value)).toEqual([
      null,
      'opus',
      'sonnet',
      'haiku',
    ]);
  });
});
