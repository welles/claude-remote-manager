import { filesystemWarning } from './repositories.service';

describe('filesystemWarning', () => {
  it('is silent when all directories share a filesystem', () => {
    expect(filesystemWarning({ '/w/repos': 1, '/w/sessions': 1 })).toBeNull();
  });

  it('warns when session clones cannot hardlink the mirrors', () => {
    expect(
      filesystemWarning({ '/w/repos': 1, '/w/sessions': 2, '/w/scratch': 1 }),
    ).toMatch(
      /^\/w\/repos, \/w\/sessions, \/w\/scratch are on different filesystems; session clones will copy/,
    );
  });
});
