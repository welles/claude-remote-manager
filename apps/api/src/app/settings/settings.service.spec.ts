import { BadRequestException, ConflictException } from '@nestjs/common';
import { openDatabase, type AppDatabase } from '../db/database';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let db: AppDatabase;
  let settings: SettingsService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    settings = new SettingsService(db);
  });
  afterEach(() => db.$client.close());

  it('starts without a commit identity', () => {
    expect(settings.get()).toEqual({
      gitAuthorName: null,
      gitAuthorEmail: null,
    });
    expect(settings.gitIdentity()).toBeNull();
    expect(() => settings.requireGitIdentity()).toThrow(ConflictException);
    expect(() => settings.requireGitIdentity()).toThrow('Settings page');
  });

  it('stores, trims and reports changes', () => {
    const changes: unknown[] = [];
    settings.changes$.subscribe((change) => changes.push(change));
    settings.update({
      gitAuthorName: ' Ada Lovelace ',
      gitAuthorEmail: 'ada@example.com',
    });
    expect(new SettingsService(db).gitIdentity()).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    settings.update({ gitAuthorEmail: 'ada@example.org' });
    expect(settings.get().gitAuthorName).toBe('Ada Lovelace');
    expect(changes).toHaveLength(2);
    settings.update({ gitAuthorName: null, gitAuthorEmail: '' });
    expect(settings.gitIdentity()).toBeNull();
  });

  it.each([
    [{ gitAuthorName: 'A <b>', gitAuthorEmail: 'a@b.c' }, 'without <'],
    [{ gitAuthorName: 'Line\nbreak', gitAuthorEmail: 'a@b.c' }, 'control'],
    [{ gitAuthorName: 'A', gitAuthorEmail: 'not-an-email' }, 'not an email'],
    [{ gitAuthorName: 'A' }, 'or neither'],
    [{ gitAuthorName: 5 }, 'must be a string'],
    [{ theme: 'dark' }, 'Unknown settings: theme'],
    ['x', 'JSON object'],
  ])('rejects %j', (request, message) => {
    expect(() => settings.update(request as never)).toThrow(
      BadRequestException,
    );
    expect(() => settings.update(request as never)).toThrow(message);
  });
});
