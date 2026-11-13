import { BadRequestException } from '@nestjs/common';
import {
  isRepositoryFullName,
  parseReferences,
} from '@claude-remote-manager/shared-types';
import { parseReferenceRequests } from './github-references.service';

describe('reference syntax', () => {
  it('accepts only names GitHub allows', () => {
    for (const name of ['acme/app', 'a-b/c.d_e', 'A1/x', 'acme/.github']) {
      expect([name, isRepositoryFullName(name)]).toEqual([name, true]);
    }
    for (const name of [
      'acme',
      'acme/app/x',
      '-acme/app',
      'acme-/app',
      'ac--me/app',
      'acme/.',
      'acme/..',
      'acme/app.git',
      'acme/a b',
      '../etc/passwd',
      'evil.com/app',
      'acme/app?x=1',
      `${'a'.repeat(40)}/app`,
      'https://evil.example/x',
    ]) {
      expect([name, isRepositoryFullName(name)]).toEqual([name, false]);
    }
  });

  it('finds #12 and owner/repo#12 in text', () => {
    const text =
      'Fix #12 and acme/lib#7, see (#3), not a#4, page#5, &#38;, `#6` or http://x/#8.';
    expect(
      parseReferences(text, 'acme/app').map(({ token, repository, number }) => [
        token,
        repository,
        number,
      ]),
    ).toEqual([
      ['#12', 'acme/app', 12],
      ['acme/lib#7', 'acme/lib', 7],
      ['#3', 'acme/app', 3],
    ]);
    // Without a GitHub repository bare numbers have no repository.
    expect(parseReferences('Fix #12', null)[0].repository).toBeNull();
    // Inside fenced code, nothing.
    expect(
      parseReferences('```\n#1\n```\n#2', 'a/b').map((r) => r.number),
    ).toEqual([2]);
    // #0 and paths are no references.
    expect(parseReferences('#0 src/a/b#1 a/b/c#2', 'a/b')).toEqual([]);
  });

  it('validates references of a message', () => {
    expect(
      parseReferenceRequests([
        { token: '#12', repository: 'acme/app', number: 12, comments: true },
        { token: 'acme/lib#7', repository: 'acme/lib', number: 7, diff: true },
        // The same item again: merged.
        { token: '#12', repository: 'ACME/app', number: 12, diff: true },
      ]),
    ).toEqual([
      {
        token: '#12',
        repository: 'acme/app',
        number: 12,
        comments: true,
        diff: true,
      },
      {
        token: 'acme/lib#7',
        repository: 'acme/lib',
        number: 7,
        comments: false,
        diff: true,
      },
    ]);
    expect(parseReferenceRequests(undefined)).toEqual([]);
    for (const bad of [
      'x',
      [{ token: '#1', repository: 'evil.com/x/y', number: 1 }],
      [{ token: '#1', repository: 'https://evil.example', number: 1 }],
      [{ token: '#1', repository: 'acme/app', number: 2 }],
      [{ token: 'other/app#1', repository: 'acme/app', number: 1 }],
      [{ token: 'see #1', repository: 'acme/app', number: 1 }],
      [{ token: '#1', repository: 'acme/app', number: 1.5 }],
      [{ token: '#1', repository: 'acme/app', number: 1, comments: 'yes' }],
      Array.from({ length: 11 }, (_, i) => ({
        token: `#${i + 1}`,
        repository: 'acme/app',
        number: i + 1,
      })),
    ]) {
      expect(() => parseReferenceRequests(bad)).toThrow(BadRequestException);
    }
  });
});
