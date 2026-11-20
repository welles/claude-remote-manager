import { ConflictException } from '@nestjs/common';
import { testAppConfig } from '../config/app-config';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  it('has no commit identity without the environment variables', () => {
    const settings = new SettingsService(testAppConfig('/tmp/unused'));
    expect(settings.get()).toEqual({
      gitAuthorName: null,
      gitAuthorEmail: null,
    });
    expect(settings.gitIdentity()).toBeNull();
    expect(() => settings.requireGitIdentity()).toThrow(ConflictException);
    expect(() => settings.requireGitIdentity()).toThrow('CRM_GIT_AUTHOR_NAME');
  });

  it('reports the configured commit identity', () => {
    const identity = { name: 'Ada Lovelace', email: 'ada@example.com' };
    const settings = new SettingsService(
      testAppConfig('/tmp/unused', { gitIdentity: identity }),
    );
    expect(settings.get()).toEqual({
      gitAuthorName: 'Ada Lovelace',
      gitAuthorEmail: 'ada@example.com',
    });
    expect(settings.requireGitIdentity()).toEqual(identity);
  });
});
