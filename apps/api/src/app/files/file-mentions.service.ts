import { isAbsolute } from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  BrowseResponse,
  BrowsedFileDto,
  FileMention,
  FileMentionsResponse,
} from '@claude-remote-manager/shared-types';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
} from '../common/process-isolation';
import { runGit } from '../git/git-runner';
import {
  isActiveDirectory,
  SessionRepository,
  type SessionDirectoryRecord,
} from '../sessions/session.repository';
import { classifyFile } from '../shown-files/file-kind';
import {
  SessionFileAccess,
  type OpenedSessionFile,
} from './session-file-access';

/** Files listed per directory at most. */
export const MAX_LISTED_FILES = 200_000;
/** Listings are reused this long (typing a query asks many times). */
export const LISTING_TTL_MS = 30_000;
export const MAX_MENTION_RESULTS = 50;
const MAX_QUERY_LENGTH = 200;
/** Files the browser gets per directory at most. */
export const MAX_BROWSED_FILES = 20_000;
/** Bytes read to tell what kind of file it is. */
const SNIFF_BYTES = 8192;
/** The browser serves files up to this size. */
export const MAX_BROWSED_BYTES = 50 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;

interface Listing {
  paths: string[];
  truncated: boolean;
  at: number;
}

/** `@path`, quoted when it contains whitespace. */
export function mentionText(path: string): string {
  return /[\s"]/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * Ranks a path for a query: every fragment (separated by spaces) must be in
 * the path; matches in the file name rank higher, then shorter paths.
 * `null` when it does not match.
 */
export function matchScore(path: string, fragments: string[]): number | null {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  let score = 0;
  for (const fragment of fragments) {
    if (!lower.includes(fragment)) {
      return null;
    }
    if (name.startsWith(fragment)) {
      score += 30;
    } else if (name.includes(fragment)) {
      score += 20;
    } else if (lower.includes(`/${fragment}`) || lower.startsWith(fragment)) {
      score += 5;
    }
  }
  return score * 1000 - Math.min(path.length, 999);
}

/**
 * Files of a session's directories for `@` references: in session clones
 * the files git knows plus untracked ones that are not ignored
 * (`git ls-files`, so `.gitignore` is respected), elsewhere (scratch) a
 * walk that skips `.git` and `node_modules`. Listed as the session user,
 * cached briefly, searched by path fragments.
 */
@Injectable()
export class FileMentionsService {
  private readonly listings = new Map<string, Promise<Listing>>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly files: SessionFileAccess,
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    private readonly launcher: ProcessLauncher = SINGLE_USER,
  ) {}

  async search(
    sessionId: string,
    query: string,
    limit = MAX_MENTION_RESULTS,
  ): Promise<FileMentionsResponse> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException('The query is too long');
    }
    const count = Math.max(1, Math.min(limit, MAX_MENTION_RESULTS));
    const fragments = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches: { mention: FileMention; score: number }[] = [];
    let truncated = false;
    // Repositories being added (or held) are not Claude's yet.
    const directories = record.directories.filter(
      (directory) =>
        directory.state === 'ready' && isActiveDirectory(directory),
    );
    for (const directory of directories) {
      const listing = await this.listing(directory);
      truncated ||= listing.truncated;
      for (const path of listing.paths) {
        const score = matchScore(path, fragments);
        if (score !== null) {
          matches.push({
            score,
            mention: {
              directory: directory.position,
              repository: directory.repositoryName,
              path,
              mention: mentionText(
                directory.position === 0
                  ? path
                  : `${directory.path.replace(/\/+$/, '')}/${path}`,
              ),
            },
          });
        }
      }
    }
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        a.mention.directory - b.mention.directory ||
        (a.mention.path < b.mention.path ? -1 : 1),
    );
    return {
      files: matches.slice(0, count).map((match) => match.mention),
      truncated: truncated || matches.length > count,
    };
  }

  /**
   * The session's ready directories with their files (as for `@`, at most
   * {@link MAX_BROWSED_FILES} each), for the file browser.
   */
  async browse(sessionId: string): Promise<BrowseResponse> {
    const directories: BrowseResponse['directories'] = [];
    for (const directory of this.readyDirectories(sessionId)) {
      const listing = await this.listing(directory);
      const files = [...listing.paths].sort();
      directories.push({
        directory: directory.position,
        repository: directory.repositoryName,
        path: directory.path,
        files: files.slice(0, MAX_BROWSED_FILES),
        truncated: listing.truncated || files.length > MAX_BROWSED_FILES,
      });
    }
    return { directories };
  }

  /** What kind of file it is (read inside its directory only). */
  async browsedFile(
    sessionId: string,
    position: number,
    path: string,
  ): Promise<BrowsedFileDto> {
    const directory = this.browsable(sessionId, position, path);
    const file = await this.files.read([directory.path], path, SNIFF_BYTES);
    const name = path.split('/').at(-1) ?? path;
    return {
      directory: position,
      path,
      name,
      ...classifyFile(name, file.data, !file.truncated),
      size: file.size,
      mention: mentionText(
        position === 0 ? path : `${directory.path.replace(/\/+$/, '')}/${path}`,
      ),
    };
  }

  /** Opens the file for serving, up to {@link MAX_BROWSED_BYTES}. */
  async openBrowsed(
    sessionId: string,
    position: number,
    path: string,
  ): Promise<OpenedSessionFile> {
    const directory = this.browsable(sessionId, position, path);
    return this.files.stream([directory.path], path, MAX_BROWSED_BYTES);
  }

  /**
   * The directory a browsed path belongs to: a relative path without `..`
   * in one of the session's ready directories (the helper also refuses
   * real paths outside it, e.g. through symlinks).
   */
  private browsable(
    sessionId: string,
    position: number,
    path: string,
  ): SessionDirectoryRecord {
    if (
      !path ||
      path.length > MAX_PATH_LENGTH ||
      path.startsWith('/') ||
      path.includes('\0') ||
      path.split('/').some((part) => part === '..' || part === '')
    ) {
      throw new BadRequestException(
        'path must be a relative path in the directory',
      );
    }
    const directory = this.readyDirectories(sessionId).find(
      (candidate) => candidate.position === position,
    );
    if (!directory || !isAbsolute(directory.path)) {
      throw new NotFoundException('No such directory in the session');
    }
    return directory;
  }

  private readyDirectories(sessionId: string): SessionDirectoryRecord[] {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    // Repositories being added (or held) are not Claude's yet.
    return record.directories.filter(
      (directory) =>
        directory.state === 'ready' && isActiveDirectory(directory),
    );
  }

  /** The files of a directory (cached for {@link LISTING_TTL_MS}). */
  private listing(directory: SessionDirectoryRecord): Promise<Listing> {
    const key = directory.path;
    const cached = this.listings.get(key);
    if (cached) {
      return cached.then((listing) =>
        Date.now() - listing.at < LISTING_TTL_MS
          ? listing
          : this.refresh(directory),
      );
    }
    return this.refresh(directory);
  }

  private refresh(directory: SessionDirectoryRecord): Promise<Listing> {
    const listing = this.list(directory);
    this.listings.set(directory.path, listing);
    listing.catch(() => this.listings.delete(directory.path));
    return listing;
  }

  private async list(directory: SessionDirectoryRecord): Promise<Listing> {
    if (!isAbsolute(directory.path)) {
      return { paths: [], truncated: false, at: Date.now() };
    }
    if (directory.kind === 'clone') {
      try {
        const output = await runGit(
          [
            'ls-files',
            '-z',
            '--cached',
            '--others',
            '--exclude-standard',
            '--deduplicate',
          ],
          {
            cwd: directory.path,
            launcher: this.launcher,
            as: 'session',
            env: { GIT_OPTIONAL_LOCKS: '0' },
          },
        );
        const paths = output.split('\0').filter(Boolean);
        return {
          paths: paths.slice(0, MAX_LISTED_FILES),
          truncated: paths.length > MAX_LISTED_FILES,
          at: Date.now(),
        };
      } catch {
        // Not a git repository (anymore): walk it.
      }
    }
    const { paths, truncated } = await this.files.list(
      directory.path,
      MAX_LISTED_FILES,
    );
    return { paths, truncated, at: Date.now() };
  }
}
