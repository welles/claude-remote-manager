import {
  ApprovalGrants,
  CREATE_PULL_REQUEST_TOOL_NAME,
  isGitPushCommand,
  PUSH_GRANT_MS,
} from './approval-grants';

describe('isGitPushCommand', () => {
  it.each([
    'git push',
    'git push -u origin HEAD',
    'cd /w/app && git push origin claude/x',
    'git -C /w/app push',
    'git -c http.extraHeader=x push',
    'npm test; git push',
    '/usr/bin/git push --force-with-lease',
    'echo $(git push)',
  ])('recognizes %s', (command) => {
    expect(isGitPushCommand(command)).toBe(true);
  });

  it.each([
    'git status',
    'git log --grep push',
    'echo git push',
    'git stash push',
    'npm run push',
    'gitpush',
    'git commit -m "push later"',
  ])('does not treat %s as a push', (command) => {
    expect(isGitPushCommand(command)).toBe(false);
  });
});

describe('ApprovalGrants', () => {
  let now = 1_000_000;
  let grants: ApprovalGrants;
  const sdk = { name: 'crm', source: 'sdk' };

  beforeEach(() => {
    now = 1_000_000;
    grants = new ApprovalGrants(() => now);
  });

  it('grants pushes from the approval until the command finished', () => {
    grants.approved('s1', 'Bash', { command: 'git status' }, 't0', null);
    expect(grants.hasPushGrant('s1')).toBe(false);
    grants.approved('s1', 'Bash', { command: 'git push' }, 't1', null);
    expect(grants.hasPushGrant('s1')).toBe(true);
    expect(grants.hasPushGrant('s2')).toBe(false);
    grants.addToken('s1', 'ghs_w');
    expect(grants.toolFinished('s1', 'other')).toEqual({
      pushEnded: false,
      tokens: [],
    });
    expect(grants.toolFinished('s1', 't1')).toEqual({
      pushEnded: true,
      tokens: ['ghs_w'],
    });
    expect(grants.hasPushGrant('s1')).toBe(false);
  });

  it('lets push grants expire', () => {
    grants.approved('s1', 'Bash', { command: 'git push' }, 't1', null);
    now += PUSH_GRANT_MS + 1;
    expect(grants.hasPushGrant('s1')).toBe(false);
  });

  it('keeps tokens until the last running push finished', () => {
    grants.approved('s1', 'Bash', { command: 'git push' }, 't1', null);
    grants.approved('s1', 'Bash', { command: 'git push' }, 't2', null);
    grants.addToken('s1', 'ghs_w');
    expect(grants.toolFinished('s1', 't1').tokens).toEqual([]);
    expect(grants.toolFinished('s1', 't2').tokens).toEqual(['ghs_w']);
  });

  it('lets each approved pull request call run once with the approved input', () => {
    const input = { title: 'Fix', body: 'b' };
    grants.approved('s1', CREATE_PULL_REQUEST_TOOL_NAME, input, 't1', sdk);
    expect(grants.consumePullRequestGrant('s1', { title: 'Other' })).toBe(
      false,
    );
    expect(
      grants.consumePullRequestGrant('s1', { ...input, draft: false }),
    ).toBe(true);
    expect(grants.consumePullRequestGrant('s1', input)).toBe(false);
  });

  it('ignores a tool of the same name from a configured MCP server', () => {
    grants.approved('s1', CREATE_PULL_REQUEST_TOOL_NAME, { title: 'x' }, 't1', {
      name: 'crm',
      source: 'project',
    });
    expect(grants.consumePullRequestGrant('s1', { title: 'x' })).toBe(false);
  });

  it('forgets everything of a session and returns its tokens', () => {
    grants.approved('s1', 'Bash', { command: 'git push' }, 't1', null);
    grants.addToken('s1', 'ghs_w');
    expect(grants.clear('s1')).toEqual(['ghs_w']);
    expect(grants.hasPushGrant('s1')).toBe(false);
  });
});
