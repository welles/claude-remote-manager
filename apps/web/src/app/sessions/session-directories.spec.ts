import { relativePaths, sessionPath } from './session-directories';
import { sessionDto } from './testing/session-dto';

describe('paths of a session', () => {
  it('are relative to the working directory, also after a switch', () => {
    const first = sessionDto().directories[0];
    const second = {
      ...first,
      path: `${first.path}-2`,
      branch: 'claude/reply-with-pong-abc123-2',
    };
    const before = [first, { ...second, role: 'additional' as const }];
    expect(sessionPath(`${first.path}/src/a.ts`, before)).toBe('src/a.ts');
    expect(sessionPath(`${second.path}/src/a.ts`, before)).toBe(
      'acme/app/src/a.ts',
    );

    // switch_directory made the second clone the working directory.
    const after = [
      { ...first, role: 'additional' as const },
      { ...second, role: 'main' as const },
    ];
    expect(sessionPath(`${second.path}/src/a.ts`, after)).toBe('src/a.ts');
    expect(sessionPath(`${first.path}/src/a.ts`, after)).toBe(
      'acme/app/src/a.ts',
    );
    expect(relativePaths(`cat ${second.path}/src/a.ts`, after)).toBe(
      'cat src/a.ts',
    );
    expect(relativePaths(`ls ${first.path}`, after)).toBe('ls acme/app');
  });
});
