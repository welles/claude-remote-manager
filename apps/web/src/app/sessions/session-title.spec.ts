import { sessionSubtitle } from './session-title';
import { sessionDto } from './testing/session-dto';

describe('sessionSubtitle', () => {
  it('names the repositories and the branch of the working directory', () => {
    const base = sessionDto();
    const first = base.directories[0];
    expect(sessionSubtitle(base)).toBe(
      'acme/app · claude/reply-with-pong-abc123',
    );
    // After switch_directory the second clone is the working directory.
    const switched = sessionDto({
      directories: [
        { ...first, role: 'additional' },
        {
          ...first,
          role: 'main',
          path: `${first.path}-2`,
          branch: 'claude/reply-with-pong-abc123-2',
        },
      ],
    });
    expect(sessionSubtitle(switched)).toBe(
      'acme/app + acme/app · claude/reply-with-pong-abc123-2',
    );
  });
});
