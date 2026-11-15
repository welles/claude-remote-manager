import { Component, computed, input } from '@angular/core';
import type {
  RepositoryAdditionState,
  SessionDirectoryDto,
} from '@claude-remote-manager/shared-types';

/** Tags of repositories added while the session ran. */
export const ADDITION_LABELS: Record<RepositoryAdditionState, string> = {
  preparing: 'adding…',
  failed: 'not added',
  held: 'held: setup failed',
  ready: 'added',
};

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

/**
 * A command or path from a tool call with the session's directories
 * shortened like {@link sessionPath}: `/…/sessions/x/acme/app/src/a.ts`
 * becomes `src/a.ts`, the working directory itself `.`.
 */
export function relativePaths(
  text: string,
  directories: SessionDirectoryDto[],
): string {
  const roots = directories
    .map((directory) => ({
      root: directory.path.replace(/\/+$/, ''),
      prefix:
        directory.role === 'main' || directories.length === 1
          ? ''
          : `${directoryName(directory)}/`,
    }))
    .filter(({ root }) => root.length > 1)
    .sort((a, b) => b.root.length - a.root.length);
  let result = text;
  for (const { root, prefix } of roots) {
    result = result
      .split(`${root}/`)
      .join(prefix)
      .replace(
        new RegExp(
          `${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s'"])`,
          'g',
        ),
        prefix ? prefix.slice(0, -1) : '.',
      );
  }
  return result;
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
  protected readonly additionLabels = ADDITION_LABELS;
  /** Repository names (or project) for the collapsed list. */
  protected readonly summary = computed(() =>
    this.directories()
      .map((directory) => directoryName(directory))
      .join(' + '),
  );
}
