import { childEnvironment, isSecretVariable } from './child-environment';

describe('childEnvironment', () => {
  const base = {
    PATH: '/bin',
    HOME: '/home/claude',
    CRM_SECRET_NTFY_TOKEN: 'ntfy',
    CRM_SECRET_FORGOTTEN: 'new secret nobody registered',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'sk',
    UNDEFINED: undefined,
  };

  it('removes registered and prefixed secrets and adds extras', () => {
    expect(childEnvironment({ CRM_REPOSITORY: 'acme/app' }, { base })).toEqual({
      PATH: '/bin',
      HOME: '/home/claude',
      CRM_REPOSITORY: 'acme/app',
    });
  });

  it('keeps only the secrets named explicitly', () => {
    expect(
      childEnvironment({}, { base, keep: ['CLAUDE_CODE_OAUTH_TOKEN'] }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    });
  });

  it('recognizes secrets by prefix and name', () => {
    expect(isSecretVariable('CRM_SECRET_X')).toBe(true);
    expect(isSecretVariable('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    expect(isSecretVariable('CRM_SESSION_ID')).toBe(false);
  });
});
