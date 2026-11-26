import { eq } from 'drizzle-orm';
import { openDatabase, type AppDatabase } from '../db/database';
import { appSettings } from '../db/schema';
import { REVIEW_DEFAULTS_KEY, ReviewDefaultsStore } from './review-defaults';

describe('ReviewDefaultsStore', () => {
  let db: AppDatabase;
  let store: ReviewDefaultsStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ReviewDefaultsStore(db);
  });

  it('defaults to Fable 5.2 with high effort', () => {
    expect(store.get()).toEqual({
      model: 'claude-fable-5-2',
      effort: 'high',
    });
  });

  it('stores changes and keeps what the request leaves out', () => {
    store.update({ model: 'opus' });
    store.update({ effort: 'xhigh' });
    expect(new ReviewDefaultsStore(db).get()).toEqual({
      model: 'opus',
      effort: 'xhigh',
    });
  });

  it('ignores the former round limit in stored settings and requests', () => {
    store.update({ maxAutoRounds: 5 } as never);
    db.update(appSettings)
      .set({ value: { model: 'opus', effort: 'low', maxAutoRounds: 5 } })
      .where(eq(appSettings.key, REVIEW_DEFAULTS_KEY))
      .run();
    expect(store.get()).toEqual({ model: 'opus', effort: 'low' });
  });

  it('refuses invalid values', () => {
    expect(() => store.update({ model: 'a@b' })).toThrow('model');
    expect(() => store.update({ model: '' })).toThrow('model');
    expect(() =>
      store.update({ effort: 'extreme' as unknown as 'high' }),
    ).toThrow('effort');
    expect(store.get().model).toBe('claude-fable-5-2');
  });
});
