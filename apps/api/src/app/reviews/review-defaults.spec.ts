import { eq } from 'drizzle-orm';
import { openDatabase, type AppDatabase } from '../db/database';
import { appSettings } from '../db/schema';
import { REVIEW_DEFAULTS_KEY, ReviewDefaultsStore } from './review-defaults';

describe('ReviewDefaultsStore', () => {
  let db: AppDatabase;
  let store: ReviewDefaultsStore;
  const both = () => true;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ReviewDefaultsStore(db);
  });

  it('defaults to Claude Code with Fable 5.2 and high effort, Codex with its default model', () => {
    expect(store.get()).toEqual({
      engine: 'claude-code',
      models: { 'claude-code': 'claude-fable-5-2', codex: null },
      effort: 'high',
    });
  });

  it('stores changes and keeps what the request leaves out', () => {
    store.update({ model: 'opus' });
    store.update({ effort: 'xhigh' });
    expect(new ReviewDefaultsStore(db).get()).toEqual({
      engine: 'claude-code',
      models: { 'claude-code': 'opus', codex: null },
      effort: 'xhigh',
    });
  });

  it('keeps a model per engine; the model of a request is the engine’s', () => {
    store.update({ model: 'opus' });
    store.update({ engine: 'codex', model: 'gpt-5.4' }, both);
    expect(store.get()).toEqual({
      engine: 'codex',
      models: { 'claude-code': 'opus', codex: 'gpt-5.4' },
      effort: 'high',
    });
    // `null`: the engine's default model of reviews.
    store.update({ model: null }, both);
    expect(store.get().models.codex).toBeNull();
    store.update({ engine: 'claude-code', model: null }, both);
    expect(store.get().models).toEqual({
      'claude-code': 'claude-fable-5-2',
      codex: null,
    });
  });

  it('offers only the engines the server has', () => {
    expect(() => store.update({ engine: 'codex' })).toThrow(
      'not available on this server',
    );
    expect(() =>
      store.update({ engine: 'gemini' as unknown as 'codex' }, both),
    ).toThrow('engine must be one of');
    expect(store.get().engine).toBe('claude-code');
  });

  it('reads the settings from before Codex and ignores the former round limit', () => {
    store.update({ maxAutoRounds: 5 } as never);
    db.update(appSettings)
      .set({ value: { model: 'opus', effort: 'low', maxAutoRounds: 5 } })
      .where(eq(appSettings.key, REVIEW_DEFAULTS_KEY))
      .run();
    expect(store.get()).toEqual({
      engine: 'claude-code',
      models: { 'claude-code': 'opus', codex: null },
      effort: 'low',
    });
  });

  it('refuses invalid values', () => {
    expect(() => store.update({ model: 'a@b' })).toThrow('model');
    expect(() => store.update({ model: '' })).toThrow('model');
    expect(() =>
      store.update({ effort: 'extreme' as unknown as 'high' }),
    ).toThrow('effort');
    expect(store.get().models['claude-code']).toBe('claude-fable-5-2');
  });
});
