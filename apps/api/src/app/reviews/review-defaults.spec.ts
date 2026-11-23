import { openDatabase, type AppDatabase } from '../db/database';
import { ReviewDefaultsStore } from './review-defaults';

describe('ReviewDefaultsStore', () => {
  let db: AppDatabase;
  let store: ReviewDefaultsStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ReviewDefaultsStore(db);
  });

  it('defaults to Fable 5.2 with high effort and 3 auto-review rounds', () => {
    expect(store.get()).toEqual({
      model: 'claude-fable-5-2',
      effort: 'high',
      maxAutoRounds: 3,
    });
  });

  it('stores changes and keeps what the request leaves out', () => {
    store.update({ model: 'opus', effort: 'xhigh' });
    store.update({ maxAutoRounds: 5 });
    expect(new ReviewDefaultsStore(db).get()).toEqual({
      model: 'opus',
      effort: 'xhigh',
      maxAutoRounds: 5,
    });
  });

  it('refuses invalid values', () => {
    expect(() => store.update({ model: 'a@b' })).toThrow('model');
    expect(() => store.update({ model: '' })).toThrow('model');
    expect(() =>
      store.update({ effort: 'extreme' as unknown as 'high' }),
    ).toThrow('effort');
    expect(() => store.update({ maxAutoRounds: 0 })).toThrow('maxAutoRounds');
    expect(() => store.update({ maxAutoRounds: 1.5 })).toThrow('maxAutoRounds');
    expect(store.get().model).toBe('claude-fable-5-2');
  });
});
