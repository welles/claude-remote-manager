import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  AgentEngineId,
  ModelListResponse,
  ReviewDefaults,
} from '@claude-remote-manager/shared-types';
import { flushEngines } from '../engines/testing/engines';
import { choose, optionsOf } from '../testing/select';
import { words } from '../testing/text';
import { ReviewSettings } from './review-settings';

const defaults = (overrides: Partial<ReviewDefaults> = {}): ReviewDefaults => ({
  engine: 'claude-code',
  models: { 'claude-code': 'claude-fable-5-2', codex: null },
  effort: 'high',
  ...overrides,
});

const claudeModels: ModelListResponse = {
  models: [
    {
      value: null,
      label: 'Default (recommended)',
      description: '',
      resolvedModel: 'claude-opus-5-5',
    },
    {
      value: 'opus',
      label: 'Opus 5.5',
      description: '',
      resolvedModel: 'claude-opus-5-5',
    },
  ],
  source: 'claude-code',
  updatedAt: null,
};

const codexModels: ModelListResponse = {
  models: [
    {
      value: null,
      label: 'GPT-5.5 Codex',
      description: '',
      resolvedModel: 'gpt-5.5-codex',
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: '',
      resolvedModel: 'gpt-5.4',
    },
  ],
  source: 'codex',
  updatedAt: null,
};

describe('ReviewSettings', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReviewSettings],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    document.querySelector('.cdk-overlay-container')?.replaceChildren();
  });

  const render = async (
    stored: ReviewDefaults,
    engines: AgentEngineId[] = ['claude-code'],
  ) => {
    const fixture = TestBed.createComponent(ReviewSettings);
    fixture.detectChanges();
    http.expectOne('/api/settings/review').flush(stored);
    flushEngines(http, ...engines);
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = (testId: string) =>
      [...element.querySelectorAll(`[data-testid="${testId}"]`)].map((node) =>
        words(node as HTMLElement),
      );
    return { fixture, element, text };
  };

  const flushModels = async (
    fixture: ComponentFixture<unknown>,
    url: string,
    list: ModelListResponse,
  ) => {
    http.expectOne(url).flush(list);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('looks as before with one engine: Claude Code’s models, no engine choice', async () => {
    const { fixture, text } = await render(defaults());
    await flushModels(fixture, '/api/models', claudeModels);
    expect(text('review-default-engine')).toEqual([]);
    expect(text('review-default-model')).toEqual(['Fable 5.2']);
    expect(await optionsOf(fixture, 'review-default-model')).toEqual([
      'Fable 5.2',
      'Opus 5.5',
    ]);
    expect(await optionsOf(fixture, 'review-default-effort')).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);
  });

  it('chooses the engine with several, and shows the chosen engine’s models', async () => {
    const { fixture, text } = await render(defaults(), [
      'claude-code',
      'codex',
    ]);
    await flushModels(fixture, '/api/models', claudeModels);
    expect(text('review-default-engine')).toEqual(['Claude Code']);
    await choose(fixture, 'review-default-engine', 'Codex');
    const save = http.expectOne('/api/settings/review');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body).toEqual({ engine: 'codex' });
    save.flush(defaults({ engine: 'codex' }));
    fixture.detectChanges();
    await fixture.whenStable();
    await flushModels(fixture, '/api/models?engine=codex', codexModels);
    expect(text('review-default-engine')).toEqual(['Codex']);
    // Codex's default model is a choice of its own.
    expect(text('review-default-model')).toEqual(['GPT-5.5 Codex']);
    expect(await optionsOf(fixture, 'review-default-model')).toEqual([
      'GPT-5.5 Codex',
      'GPT-5.4',
    ]);
    await choose(fixture, 'review-default-model', 'GPT-5.4');
    const model = http.expectOne('/api/settings/review');
    expect(model.request.body).toEqual({ model: 'gpt-5.4' });
    model.flush(
      defaults({
        engine: 'codex',
        models: { 'claude-code': 'claude-fable-5-2', codex: 'gpt-5.4' },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text('review-default-model')).toEqual(['GPT-5.4']);
  });

  it('says when the chosen engine is not on the server', async () => {
    const { fixture, text } = await render(defaults({ engine: 'codex' }));
    await flushModels(fixture, '/api/models', claudeModels);
    expect(text('review-default-engine')).toEqual([]);
    expect(text('review-default-fallback')).toEqual([
      'Codex is not available on this server: reviews run with Claude Code instead.',
    ]);
    expect(text('review-default-model')).toEqual(['Fable 5.2']);
  });
});
