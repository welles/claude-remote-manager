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
