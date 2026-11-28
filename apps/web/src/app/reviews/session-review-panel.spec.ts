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
  SessionDto,
  SessionReviewDto,
} from '@claude-remote-manager/shared-types';
import { flushEngines } from '../engines/testing/engines';
import { sessionDto } from '../sessions/testing/session-dto';
import { choose, optionsOf } from '../testing/select';
import { words } from '../testing/text';
import { SessionReviewPanel } from './session-review-panel';

const defaults = (overrides: Partial<ReviewDefaults> = {}): ReviewDefaults => ({
  engine: 'claude-code',
  models: { 'claude-code': 'claude-fable-5-2', codex: null },
  effort: 'high',
  ...overrides,
});

const review = (
  overrides: Partial<SessionReviewDto> = {},
): SessionReviewDto => ({
  mode: 'claude',
  engine: null,
  model: null,
  effort: null,
  running: null,
  ...overrides,
});

const claudeModels: ModelListResponse = {
  models: [
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

describe('SessionReviewPanel', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionReviewPanel],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const render = async (
    session: SessionDto,
    stored: ReviewDefaults = defaults(),
    engines: AgentEngineId[] = ['claude-code'],
  ) => {
    const fixture = TestBed.createComponent(SessionReviewPanel);
    fixture.componentRef.setInput('session', session);
    const changed: SessionDto[] = [];
    fixture.componentInstance.changed.subscribe((value) => changed.push(value));
    fixture.detectChanges();
    flushEngines(http, ...engines);
    http.expectOne('/api/settings/review').flush(stored);
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = (testId: string) =>
      [...element.querySelectorAll(`[data-testid="${testId}"]`)].map((node) =>
        words(node as HTMLElement),
      );
    return { fixture, element, text, changed };
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

  it('looks as before with one engine', async () => {
    const { fixture, text } = await render(sessionDto({ review: review() }));
    await flushModels(fixture, '/api/models', claudeModels);
    expect(text('review-engine-select')).toEqual([]);
    expect(await optionsOf(fixture, 'review-model-select')).toEqual([
      'App default (Fable 5.2)',
      'Fable 5.2',
      'Opus 5.5',
    ]);
  });

  it('offers the engine with several and the models of the reviewer’s engine', async () => {
    const { fixture, text, changed } = await render(
      sessionDto({ review: review() }),
      defaults({ engine: 'codex' }),
      ['claude-code', 'codex'],
    );
    await flushModels(fixture, '/api/models?engine=codex', codexModels);
    expect(text('review-engine-select')).toEqual(['App default (Codex)']);
    // Codex's models; "App default" stands for its default model.
    expect(await optionsOf(fixture, 'review-model-select')).toEqual([
      'App default (Default (GPT-5.5 Codex))',
      'GPT-5.4',
    ]);
    expect(await optionsOf(fixture, 'review-effort-select')).toEqual([
      'App default (High)',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);

    await choose(fixture, 'review-engine-select', 'Claude Code');
    const request = http.expectOne('/api/sessions/s1/review-settings');
    expect(request.request.body).toEqual({ engine: 'claude-code' });
    const updated = sessionDto({ review: review({ engine: 'claude-code' }) });
    request.flush(updated);
    expect(changed).toEqual([updated]);
    fixture.componentRef.setInput('session', updated);
    fixture.detectChanges();
    await fixture.whenStable();
    await flushModels(fixture, '/api/models', claudeModels);
    expect(await optionsOf(fixture, 'review-model-select')).toEqual([
      'App default (Fable 5.2)',
      'Fable 5.2',
      'Opus 5.5',
    ]);
  });

  it('names the engine of a running review with several', async () => {
    const { fixture, text } = await render(
      sessionDto({
        review: review({
          running: {
            id: 'r1',
            trigger: 'manual',
            engine: 'codex',
            fallbackFrom: null,
            fallbackReason: null,
            model: null,
            effort: 'high',
            startedAt: '2026-01-01T10:00:00.000Z',
            fileCount: 2,
          },
        }),
      }),
      defaults({ engine: 'codex' }),
      ['claude-code', 'codex'],
    );
    await flushModels(fixture, '/api/models?engine=codex', codexModels);
    // Claude Code's, asked for before the settings were known.
    await flushModels(fixture, '/api/models', claudeModels);
    expect(text('review-running')).toEqual([
      'Review runs (Codex, Default (GPT-5.5 Codex))…',
    ]);
  });

  it('says when the chosen engine is not on the server', async () => {
    const { fixture, text } = await render(
      sessionDto({ review: review({ engine: 'codex', model: 'gpt-5.4' }) }),
    );
    await flushModels(fixture, '/api/models', claudeModels);
    expect(text('review-fallback')).toEqual([
      'Codex is not available on this server: reviews run with Claude Code instead.',
    ]);
  });
});
