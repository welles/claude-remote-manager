import { parseCloneUrl } from './clone-url';

describe('parseCloneUrl', () => {
  it.each([
    [
      'https://github.com/acme/tool.git',
      'https://github.com/acme/tool.git',
      'acme',
      'tool',
    ],
    [
      ' https://github.com/acme/tool ',
      'https://github.com/acme/tool',
      'acme',
      'tool',
    ],
    [
      'https://gitlab.example.com:8443/group/sub/my.repo.git/',
      'https://gitlab.example.com:8443/group/sub/my.repo.git/',
      'sub',
      'my.repo',
    ],
    [
      'ssh://git@github.com/acme/tool.git',
      'ssh://git@github.com/acme/tool.git',
      'acme',
      'tool',
    ],
    [
      'git@github.com:acme/tool.git',
      'git@github.com:acme/tool.git',
      'acme',
      'tool',
    ],
    ['github.com:acme/tool', 'github.com:acme/tool', 'acme', 'tool'],
    ['/srv/git/acme/tool.git/', '/srv/git/acme/tool.git', 'acme', 'tool'],
    ['/srv//git/./x/../tool', '/srv/git/tool', 'git', 'tool'],
    ['/tool', '/tool', 'local', 'tool'],
    ['file:///srv/git/acme/tool.git', '/srv/git/acme/tool.git', 'acme', 'tool'],
  ])('accepts %s', (input, url, owner, name) => {
    expect(parseCloneUrl(input)).toEqual({ url, owner, name });
  });

  it.each([
    ['', 'empty'],
    ['-uhttps://x/a/b', 'start with "-"'],
    ['--upload-pack=touch /tmp/x', 'whitespace'],
    ['https://github.com/acme/tool name', 'whitespace'],
    ['https://github.com/acme/to\tol', 'whitespace'],
    ['https://user:token@github.com/acme/tool', 'credentials'],
    ['https://token@github.com/acme/tool', 'credentials'],
    ['https://github.com/acme/tool?x=1', 'query'],
    ['http://github.com/acme/tool', 'Unsupported protocol http'],
    ['git://github.com/acme/tool', 'Unsupported protocol git'],
    ['ext::sh -c touch% /tmp/pwned', 'whitespace'],
    ['ext::sh', 'Remote helper'],
    ['fd::17', 'Remote helper'],
    ['https://github.com/acme/tool::x', 'Remote helper'],
    ['file://host/srv/tool', 'absolute local path'],
    ['relative/path', 'Use an https://'],
    ['https://github.com/', 'repository name'],
    ['https://github.com/acme/..', 'repository name'],
    ['https://github.com/ac%20me/tool', 'owner'],
    ['https://github.com/acme/.git', 'repository name'],
    [`https://github.com/acme/${'x'.repeat(500)}`, 'longer than'],
  ])('refuses %j', (input, message) => {
    expect(() => parseCloneUrl(input)).toThrow(message);
  });
});
