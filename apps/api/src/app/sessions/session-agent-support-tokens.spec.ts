import type { AppConfig } from '../config/app-config';
import type { GitService } from '../git/git.service';
import type { ShownFilesService } from '../shown-files/shown-files.service';
import {
  GITHUB_HELPER_SCRIPT,
  SessionAgentSupportService,
} from './session-agent-support';
import type { SessionGitService } from './session-git.service';
import type { SessionGitHubTokensService } from './session-github-tokens.service';
import type { SessionRecord } from './session.repository';
import { SessionTokens } from './session-tokens';

const SESSION = '5b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('GitHub token environment of session processes', () => {
  const record = (github: boolean) =>
    ({
      id: SESSION,
      directories: [
        {
          path: '/nonexistent/clone',
          kind: 'clone',
          state: 'ready',
          repositoryId: null,
          repositoryGitHub: github,
        },
      ],
    }) as unknown as SessionRecord;

  const support = (separated: boolean) => {
    const processTokens = new SessionTokens();
    const released: string[] = [];
    const tokens = {
      processTokens,
      release: (id: string) => {
        released.push(id);
        processTokens.revoke(id);
      },
    } as unknown as SessionGitHubTokensService;
    const service = new SessionAgentSupportService(
      {
        internalApiUrl: 'http://127.0.0.1:8080',
        memoryDir: '/nonexistent',
      } as AppConfig,
      {} as SessionGitService,
      { launcher: { separated } } as unknown as GitService,
      {} as ShownFilesService,
      undefined,
      undefined,
      tokens,
    );
    return { service, processTokens, released };
  };

  it('configures git and gh for the API’s tokens in the container', async () => {
    const { service, processTokens, released } = support(true);
    const { env } = await service.prepare(record(true));
    expect(env).toMatchObject({
      CRM_API_URL: 'http://127.0.0.1:8080',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.useHttpPath',
      GIT_CONFIG_VALUE_2: 'true',
    });
    expect(env['GIT_CONFIG_VALUE_1']).toContain(GITHUB_HELPER_SCRIPT);
    expect(env['GIT_CONFIG_VALUE_1']).toMatch(/ git-credential$/);
    expect(processTokens.resolve(env['CRM_SESSION_TOKEN'])).toBe(SESSION);
    // A new process: the earlier process's token stops working.
    const next = await service.prepare(record(true));
    expect(processTokens.resolve(env['CRM_SESSION_TOKEN'])).toBeNull();
    expect(processTokens.resolve(next.env['CRM_SESSION_TOKEN'])).toBe(SESSION);
    service.released(SESSION);
    expect(released.at(-1)).toBe(SESSION);
    expect(processTokens.resolve(next.env['CRM_SESSION_TOKEN'])).toBeNull();
  });

  it('gives nothing without GitHub repositories or outside the container', async () => {
    expect((await support(true).service.prepare(record(false))).env).toEqual(
      {},
    );
    expect((await support(false).service.prepare(record(true))).env).toEqual(
      {},
    );
  });
});
