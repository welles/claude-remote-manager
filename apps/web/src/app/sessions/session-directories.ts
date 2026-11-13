import { Component, computed, input } from '@angular/core';
import type { SessionDirectoryDto } from '@claude-remote-manager/shared-types';

/** Name of a session directory: repository, scratch or the directory. */
export function directoryName(directory: SessionDirectoryDto): string {
  if (directory.repository) {
    return directory.repository.fullName;
  }
  if (directory.kind === 'scratch') {
    return 'Scratch directory';
  }
  return directory.path.split('/').filter(Boolean).at(-1) ?? directory.path;
}

/**
 * A path of the session, short: relative to the working directory, or the
 * repository's name and the path in its clone; other paths unchanged.
 */
export function sessionPath(
  path: string,
  directories: SessionDirectoryDto[],
): string {
  for (const directory of directories) {
    const root = directory.path.replace(/\/+$/, '');
    if (path.startsWith(`${root}/`)) {
      const relative = path.slice(root.length + 1);
      return directory.role === 'main' || directories.length === 1
        ? relative
        : `${directoryName(directory)}/${relative}`;
    }
  }
  return path;
}

/** The directories of a session (collapsed: repository names). */
@Component({
  selector: 'app-session-directories',
  templateUrl: './session-directories.html',
  styleUrl: './session-directories.scss',
})
export class SessionDirectories {
  readonly directories = input.required<SessionDirectoryDto[]>();
  protected readonly directoryName = directoryName;
  /** Repository names (or project) for the collapsed list. */
  protected readonly summary = computed(() =>
    this.directories()
      .map((directory) => directoryName(directory))
      .join(' + '),
  );
}
