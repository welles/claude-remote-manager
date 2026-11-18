import { APPROVAL_LIMIT_REASONS, approvalLimit } from './approval-limits';

const limit = (toolName: string, input: Record<string, unknown>) =>
  approvalLimit({ toolName, input, toolUseId: 't', agentId: null });
const bash = (command: string) => limit('Bash', { command });

describe('approvalLimit', () => {
  it('asks for every git push, also forms the ask rule does not cover', () => {
    for (const command of [
      'git push',
      'git push origin claude/fix-login',
      'git push --force origin main',
      'git push origin --delete main',
      'git -C ../lib push origin HEAD:main',
      'env GIT_TRACE=1 git push --all',
      'cd ../lib && git add -A && git commit -m x && git push',
      'npm test; /usr/bin/git push --tags',
      'git -c core.sshCommand=x push',
    ]) {
      expect(bash(command)).toBe(APPROVAL_LIMIT_REASONS.push);
    }
  });

  it('leaves other commands and tools to the permission mode', () => {
    for (const command of [
      'git status',
      'git commit -m "git push later"',
      'echo git push',
      'npm run push',
      'git fetch origin',
    ]) {
      expect(bash(command)).toBeNull();
    }
    expect(limit('Bash', {})).toBeNull();
    expect(limit('Edit', { file_path: '/x', command: 'git push' })).toBeNull();
    expect(limit('mcp__crm__show_file', { path: 'a.png' })).toBeNull();
    expect(limit('mcp__crm__expose_port', { port: 3000 })).toBeNull();
  });

  it("asks for the app's pull request and repository tools", () => {
    expect(limit('mcp__crm__create_pull_request', { title: 'x' })).toBe(
      APPROVAL_LIMIT_REASONS.pullRequest,
    );
    expect(limit('mcp__crm__add_repository', { repository: 'a/b' })).toBe(
      APPROVAL_LIMIT_REASONS.addRepository,
    );
  });
});
