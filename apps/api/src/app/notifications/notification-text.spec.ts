import type {
  GitPushAnalysis,
  PermissionRequestEvent,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { shorten, shortenMiddle } from './notification';
import {
  approvalActions,
  approvalSummary,
  sessionContext,
} from './notification-text';

const session = {
  id: 's1',
  title: 'Fix the login form',
  directories: [
    {
      role: 'main',
      kind: 'clone',
      path: '/w/sessions/fix-login/acme/app',
      repository: {
        id: 'r1',
        fullName: 'acme/app',
        local: false,
        github: true,
      },
    },
    {
      role: 'additional',
      kind: 'clone',
      path: '/w/sessions/fix-login/acme/lib',
      repository: {
        id: 'r2',
        fullName: 'acme/lib',
        local: false,
        github: true,
      },
    },
  ],
} as unknown as SessionDto;

const request = (
  overrides: Partial<PermissionRequestEvent>,
): PermissionRequestEvent => ({
  type: 'permission.request',
  seq: 1,
  at: null,
  requestId: 'r',
  toolUseId: 't',
  toolName: 'Bash',
  input: {},
  kind: 'tool',
  title: null,
  description: null,
  displayName: null,
  decisionReason: null,
  blockedPath: null,
  agentId: null,
  gitPushes: [],
  pullRequest: null,
  sessionAllow: null,
  questions: null,
  plan: null,
  ...overrides,
});

const push = (overrides: Partial<GitPushAnalysis>): GitPushAnalysis => ({
  command: 'git push',
  remote: 'origin',
  targets: [],
  force: false,
  deletes: false,
  everything: false,
  sessionBranchOnly: true,
  warnings: [],
  ...overrides,
});

describe('notification texts', () => {
  it('name the session and its repositories', () => {
    expect(sessionContext(session)).toBe(
      'Fix the login form · acme/app + acme/lib',
    );
  });

  it('show the command, shortened in the middle', () => {
    const command = `npm run build && ${'x'.repeat(300)} && echo done`;
    const summary = approvalSummary(request({ input: { command } }), session);
    expect(summary.action).toBe('Run a command');
    expect(summary.detail).toHaveLength(160);
    expect(summary.detail.startsWith('npm run build')).toBe(true);
    expect(summary.detail.endsWith('echo done')).toBe(true);
  });

  it('show file paths relative to the session clone', () => {
    expect(
      approvalSummary(
        request({
          toolName: 'Edit',
          input: { file_path: '/w/sessions/fix-login/acme/app/src/login.ts' },
        }),
        session,
      ),
    ).toEqual({ action: 'Edit a file', detail: 'src/login.ts' });
    expect(
      approvalSummary(
        request({
          toolName: 'Write',
          input: { file_path: '/w/sessions/fix-login/acme/lib/index.ts' },
        }),
        session,
      ).detail,
    ).toBe('lib/index.ts');
    expect(
      approvalSummary(
        request({ toolName: 'Read', input: { file_path: '/etc/passwd' } }),
        session,
      ).detail,
    ).toBe('/etc/passwd');
  });

  it('show questions, plans, pull requests and other tools', () => {
    expect(
      approvalSummary(
        request({
          kind: 'question',
          toolName: 'AskUserQuestion',
          questions: [
            {
              question: 'Which database?',
              header: 'DB',
              options: [],
              multiSelect: false,
            },
            {
              question: 'Why?',
              header: 'Why',
              options: [],
              multiSelect: false,
            },
          ],
        }),
        session,
      ),
    ).toEqual({ action: 'Claude asks', detail: 'Which database? (and more)' });
    expect(
      approvalSummary(
        request({
          kind: 'plan',
          toolName: 'ExitPlanMode',
          plan: '\n# Move auth\n\nSteps',
        }),
        session,
      ),
    ).toEqual({ action: 'Plan to review', detail: 'Move auth' });
    expect(
      approvalSummary(
        request({
          toolName: 'mcp__crm__create_pull_request',
          pullRequest: {
            repository: 'acme/app',
            title: 'Fix login',
            body: null,
            base: 'main',
            draft: false,
          },
        }),
        session,
      ),
    ).toEqual({
      action: 'Create a pull request',
      detail: 'acme/app into main: Fix login',
    });
    expect(
      approvalSummary(
        request({
          toolName: 'mcp__crm__reply_to_review_thread',
          reviewThreadReply: {
            repository: 'acme/app',
            pullRequest: 4,
            commentId: 501,
            body: 'Fixed in\nabc123',
            resolve: true,
          },
        }),
        session,
      ),
    ).toEqual({
      action: 'Reply to and resolve a review thread',
      detail: 'acme/app#4: Fixed in abc123',
    });
    expect(
      approvalSummary(
        request({
          toolName: 'WebFetch',
          input: { url: 'https://example.com/a' },
        }),
        session,
      ),
    ).toEqual({ action: 'Fetch a web page', detail: 'https://example.com/a' });
    expect(
      approvalSummary(
        request({ toolName: 'mcp__other__do', title: 'Claude wants to do it' }),
        session,
      ),
    ).toEqual({ action: 'Use do (other)', detail: 'Claude wants to do it' });
    const addition = request({
      toolName: 'mcp__crm__add_repository',
      repositoryAddition: {
        source: 'github',
        repository: 'acme/nixos-config',
        url: null,
        registered: true,
        baseBranch: 'main',
        defaultBranch: 'main',
        reason: 'r',
      },
    });
    expect(approvalSummary(addition, session)).toEqual({
      action: 'Add a repository',
      detail: 'acme/nixos-config (GitHub) from main',
    });
    // Allow (once) and Deny work as for a command.
    expect(approvalActions(addition)).toEqual(['allow', 'deny']);
  });

  it('offer Allow only for plain tool uses, never for risky pushes', () => {
    expect(approvalActions(request({}))).toEqual(['allow', 'deny']);
    expect(approvalActions(request({ gitPushes: [push({})] }))).toEqual([
      'allow',
      'deny',
    ]);
    expect(
      approvalActions(
        request({ gitPushes: [push({ sessionBranchOnly: false })] }),
      ),
    ).toEqual(['deny']);
    expect(
      approvalActions(
        request({ gitPushes: [push({ warnings: ['Force push'] })] }),
      ),
    ).toEqual(['deny']);
    expect(approvalActions(request({ kind: 'question' }))).toEqual([]);
    expect(approvalActions(request({ kind: 'plan' }))).toEqual([]);
  });

  it('shorten on one line', () => {
    expect(shorten('a\n  b   c', 10)).toBe('a b c');
    expect(shorten('abcdefghij', 5)).toBe('abcd…');
    expect(shortenMiddle('abcdefghij', 5)).toBe('abc…j');
  });
});
