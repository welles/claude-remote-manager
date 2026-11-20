import { BadRequestException } from '@nestjs/common';
import { cloneOf, cloneOfPull } from './session-clones';
import type { SessionDirectoryRecord } from './session.repository';

const clone = (
  position: number,
  branch: string,
  overrides: Partial<SessionDirectoryRecord> = {},
): SessionDirectoryRecord => ({
  position,
  path: `/s/acme/app${position ? `-${position + 1}` : ''}`,
  kind: 'clone',
  repositoryId: 'r1',
  repositoryName: 'acme/app',
  repositoryLocal: false,
  repositoryGitHub: true,
  branch,
  baseBranch: 'main',
  baseCommit: null,
  state: 'ready',
  setupStatus: 'none',
  pushedCommit: null,
  pushedAt: null,
  addition: null,
  ...overrides,
});

const retired = {
  addedAt: new Date(),
  by: 'claude' as const,
  state: 'retired' as const,
  error: null,
  announce: false,
};

describe('session clones', () => {
  const first = clone(0, 'claude/s');
  const second = clone(1, 'claude/s-2');

  it('finds the clone of a repository by branch, or the only one', () => {
    expect(cloneOf([first], 'r1')).toBe(first);
    expect(cloneOf([first, second], 'r1', 'claude/s-2')).toBe(second);
    expect(cloneOf([first, second], 'r1', 'claude/other')).toBeUndefined();
    expect(cloneOf([first], 'r2')).toBeUndefined();
  });

  it('needs the branch with several current clones', () => {
    expect(() => cloneOf([first, second], 'r1')).toThrow(BadRequestException);
    expect(() => cloneOf([first, second], 'r1')).toThrow(
      'branches claude/s, claude/s-2',
    );
  });

  it('leaves retired clones out without a branch', () => {
    const gone = clone(1, 'claude/s-2', {
      state: 'removed',
      addition: retired,
    });
    expect(cloneOf([first, gone], 'r1')).toBe(first);
    expect(cloneOf([first, gone], 'r1', 'claude/s-2')).toBe(gone);
  });

  it('finds the clone of a pull request by its head branch', () => {
    expect(
      cloneOfPull([first, second], {
        repositoryId: 'r1',
        headBranch: 'claude/s-2',
      }),
    ).toBe(second);
    expect(
      cloneOfPull([first], { repositoryId: 'r1', headBranch: 'elsewhere' }),
    ).toBe(first);
    expect(
      cloneOfPull([first, second], {
        repositoryId: 'r1',
        headBranch: 'elsewhere',
      }),
    ).toBeUndefined();
  });

  it('falls back to the only clone that is not retired for a pull request from elsewhere', () => {
    const gone = clone(1, 'claude/s-2', {
      state: 'removed',
      addition: retired,
    });
    expect(
      cloneOfPull([first, gone], {
        repositoryId: 'r1',
        headBranch: 'elsewhere',
      }),
    ).toBe(first);
  });
});
