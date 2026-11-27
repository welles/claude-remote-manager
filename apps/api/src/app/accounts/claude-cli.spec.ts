import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SINGLE_USER } from '../common/process-isolation';
import { ClaudeCli, loginUrl, parseAuthStatus } from './claude-cli';

describe('ClaudeCli', () => {
  let dir: string;
  let executable: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crm-claude-cli-'));
    executable = join(dir, 'claude');
    // Stands in for Claude Code: prints what it got and behaves like
    // `claude auth login` / `status`.
    writeFileSync(
      executable,
      `#!/bin/sh
case "$2" in
  status)
    echo '{"loggedIn": true, "email": "'"$CLAUDE_CONFIG_DIR|$CLAUDE_CODE_OAUTH_TOKEN"'", "orgName": "Org", "subscriptionType": "max", "loginExpiresAt": null}'
    ;;
  login)
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good#state" ]; then echo "Login successful."; exit 0; fi
    echo "Invalid code" >&2
    exit 1
    ;;
esac
`,
    );
    chmodSync(executable, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const account = { configDir: '/tmp/account-dir', main: false };

  it('logs in with the code from the browser', async () => {
    const login = new ClaudeCli(executable, SINGLE_USER).login(account);
    expect(await login.url).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&state=x',
    );
    login.submit(' good#state \n');
    expect(await login.done).toBeNull();
  });

  it('reports a rejected code', async () => {
    const login = new ClaudeCli(executable, SINGLE_USER).login(account);
    await login.url;
    login.submit('bad');
    expect(await login.done).toBe('Invalid code');
  });

  it('reads the status with the account directory, never the main token', async () => {
    const previous = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'main-token';
    try {
      const cli = new ClaudeCli(executable, SINGLE_USER);
      expect(await cli.status(account)).toEqual({
        loggedIn: true,
        email: '/tmp/account-dir|',
        organization: 'Org',
        subscriptionType: 'max',
        loginExpiresAt: null,
      });
    } finally {
      if (previous === undefined) {
        delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      } else {
        process.env['CLAUDE_CODE_OAUTH_TOKEN'] = previous;
      }
    }
  });

  it('parses the output of claude auth', () => {
    expect(
      parseAuthStatus('{"loggedIn": false, "authMethod": "none"}\n'),
    ).toEqual({
      loggedIn: false,
      email: null,
      organization: null,
      subscriptionType: null,
      loginExpiresAt: null,
    });
    expect(() => parseAuthStatus('error')).toThrow();
    expect(
      loginUrl('visit: https://claude.com/cai/oauth/authorize?a=1 \n'),
    ).toBe('https://claude.com/cai/oauth/authorize?a=1');
    expect(loginUrl('nothing')).toBeNull();
  });
});
