import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ModelOption } from '@claude-remote-manager/shared-types';
import {
  FALLBACK_MODEL_OPTIONS,
  ModelsStore,
  modelLabel,
  modelOptionsWith,
  readableModelName,
} from './models-store';

describe('model labels', () => {
  const options: ModelOption[] = [
    {
      value: null,
      label: 'Default (recommended)',
      description: '',
      resolvedModel: null,
    },
    { value: 'opus', label: 'Opus', description: '', resolvedModel: null },
  ];

  it("shows Claude Code's `default` like no choice", () => {
    expect(modelLabel(options, 'default')).toBe('Default');
    expect(modelOptionsWith(options, 'default')).toBe(options);
  });

  it('names the model the default currently resolves to', () => {
    const resolved: ModelOption[] = [
      { ...options[0], resolvedModel: 'claude-opus-5-5' },
      options[1],
    ];
    expect(modelLabel(resolved, null)).toBe('Opus 5.5');
    expect(modelLabel(resolved, 'default')).toBe('Opus 5.5');
    expect(modelLabel(resolved, 'opus')).toBe('Opus');
  });

  it('reads model IDs as names', () => {
    expect(readableModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(readableModelName('claude-opus-5')).toBe('Opus 5');
    expect(readableModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(readableModelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(readableModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)');
    expect(readableModelName('some-other-model')).toBe('some-other-model');
  });

  it('keeps other values', () => {
    expect(modelLabel(options, 'opus')).toBe('Opus');
    expect(modelOptionsWith(options, 'claude-old').at(-1)?.label).toBe(
      'claude-old',
    );
  });
});

describe('ModelsStore', () => {
  let http: HttpTestingController;
  let store: ModelsStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(ModelsStore);
  });
  afterEach(() => http.verify());

  const option = (value: string | null, label: string): ModelOption => ({
    value,
    label,
    description: '',
    resolvedModel: null,
  });

  it('loads and keeps the models of each engine on its own', () => {
    // Until loaded: each engine's own fallback.
    expect(store.models()).toBe(FALLBACK_MODEL_OPTIONS);
    expect(store.models('codex').map((entry) => entry.label)).toEqual([
      'Default',
    ]);
    expect(store.source('codex')).toBe('loading');

    store.load();
    store.load('claude-code');
    store.load('codex');
    store.load('codex');
    // Claude Code's without the parameter, as always; each once.
    http.expectOne('/api/models').flush({
      models: [option(null, 'Default'), option('opus', 'Opus')],
      source: 'claude-code',
      updatedAt: null,
    });
    http.expectOne('/api/models?engine=codex').flush({
      models: [option(null, 'Default'), option('gpt-5', 'GPT-5')],
      source: 'codex',
      updatedAt: null,
    });
    expect(store.models().map((entry) => entry.label)).toEqual([
      'Default',
      'Opus',
    ]);
    expect(store.models('claude-code')).toBe(store.models());
    expect(store.models('codex').map((entry) => entry.label)).toEqual([
      'Default',
      'GPT-5',
    ]);
    expect(store.source('codex')).toBe('codex');
  });

  it('keeps the fallback when an engine cannot be asked, and asks again later', () => {
    store.load('codex');
    http
      .expectOne('/api/models?engine=codex')
      .flush(null, { status: 500, statusText: 'Error' });
    expect(store.source('codex')).toBe('fallback');
    expect(store.models('codex').map((entry) => entry.label)).toEqual([
      'Default',
    ]);
    store.load('codex');
    http.expectOne('/api/models?engine=codex').flush({
      models: [option('gpt-5', 'GPT-5')],
      source: 'codex',
      updatedAt: null,
    });
    expect(store.models('codex').map((entry) => entry.label)).toEqual([
      'GPT-5',
    ]);
  });
});
