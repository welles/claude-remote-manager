import { lstat, readdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DirectoryLoss,
  MissingDirectory,
  OrphanedDirectory,
  SessionDto,
  WorkspaceOrphansResponse,
} from '@claude-remote-manager/shared-types';
import { requireObject } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { GitService } from '../git/git.service';
import { KeyedMutex } from '../git/keyed-mutex';
import { SessionRepository } from '../sessions/session.repository';
import { SessionsService } from '../sessions/sessions.service';
import { WorkspaceEntries, type WorkspaceRule } from './workspace-entries';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Directory names in a directory (no symlinks or files); `[]` if unreadable. */
async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

const RULES: Record<OrphanedDirectory['kind'], WorkspaceRule> = {
  clone: { area: 'sessions', depths: [3] },
  directory: { area: 'sessions', depths: [1, 2] },
  scratch: { area: 'scratch', depths: [1] },
};

/**
 * Finds what is left over in the workspace: directories under `sessions/`
 * and `scratch/` that no session claims (left by a crash, a deleted
 * database, or made by hand), and session directories that are gone. Says
 * what each leftover holds (as the session user: size, files, and for
 * clones uncommitted files, commits not on the remote, stash entries) and
 * removes one only after the owner confirmed, through
 * {@link WorkspaceEntries}. Only paths it lists itself can be removed.
 */
@Injectable()
export class WorkspaceOrphansService {
  private readonly lock = new KeyedMutex();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly records: SessionRepository,
    private readonly sessions: SessionsService,
    private readonly git: GitService,
    private readonly entries: WorkspaceEntries,
  ) {}

  async list(): Promise<WorkspaceOrphansResponse> {
    const found = await this.find();
    const orphans: OrphanedDirectory[] = [];
    for (const entry of found) {
      orphans.push(await this.describe(entry.path, entry.kind));
    }
    return { orphans, missing: await this.missing() };
  }

  /** Removes a leftover the list shows, after confirmation. */
  async remove(request: unknown): Promise<WorkspaceOrphansResponse> {
    const body = requireObject(request);
    if (body['confirm'] !== true) {
      throw new BadRequestException(
        'Removing needs confirm: true (after showing what is lost)',
      );
    }
    const path = body['path'];
    if (typeof path !== 'string') {
      throw new BadRequestException('path must be a string');
    }
    await this.lock.run('workspace', async () => {
      const entry = (await this.find()).find((item) => item.path === path);
      if (!entry) {
        throw new NotFoundException(
          'Not a leftover directory of the workspace (any more)',
        );
      }
      const described = await this.describe(entry.path, entry.kind);
      if (
        (!described.loss || !described.loss.clean) &&
        body['acceptLoss'] !== true
      ) {
        throw new ConflictException(
          `Removing ${path} would lose work; confirm the loss (acceptLoss)`,
        );
      }
      await this.entries.remove(path, RULES[entry.kind], this.claimed());
      if (entry.kind !== 'scratch') {
        await this.removeEmptyParents(path);
      }
    });
    return this.list();
  }

  /**
   * Marks a directory a session expects but that is gone as removed: the
   * session then shows that it cannot continue.
   */
  async forgetMissing(request: unknown): Promise<SessionDto> {
    const body = requireObject(request);
    const sessionId = body['sessionId'];
    const position = body['position'];
    if (typeof sessionId !== 'string' || typeof position !== 'number') {
      throw new BadRequestException('sessionId and position are required');
    }
    const entry = (await this.missing()).find(
      (item) => item.sessionId === sessionId && item.position === position,
    );
    if (!entry) {
      throw new NotFoundException('The directory is not missing');
    }
    this.records.updateDirectory(sessionId, position, { state: 'removed' });
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: 'warning',
      text: `The directory of ${entry.name} was gone and is now marked removed; the session can be read but no longer continued.`,
    });
    this.sessions.publishUpdate(sessionId);
    return this.sessions.get(sessionId);
  }

  // -------------------------------------------------------------------------

  /** Paths sessions use (or are about to): never removed. */
  private claimed(): string[] {
    return this.records
      .list('include')
      .flatMap((session) =>
        session.directories
          .filter(
            (directory) =>
              directory.state === 'ready' || directory.state === 'pending',
          )
          .map((directory) => directory.path),
      );
  }

  private async find(): Promise<
    { path: string; kind: OrphanedDirectory['kind'] }[]
  > {
    const claimed = this.claimed();
    const claimedSet = new Set(claimed);
    const holdsClaimed = (path: string) =>
      claimed.some((other) => other === path || other.startsWith(`${path}/`));
    const found: { path: string; kind: OrphanedDirectory['kind'] }[] = [];
    const { sessionsDir, scratchDir } = this.config;
    for (const slug of await directories(sessionsDir)) {
      const slugPath = join(sessionsDir, slug);
      let clones = 0;
      for (const owner of await directories(slugPath)) {
        const ownerPath = join(slugPath, owner);
        for (const name of await directories(ownerPath)) {
          const path = join(ownerPath, name);
          clones++;
          if (!claimedSet.has(path) && !holdsClaimed(path)) {
            found.push({ path, kind: 'clone' });
          }
        }
      }
      if (clones === 0 && !holdsClaimed(slugPath)) {
        // Nothing that looks like a clone: an empty or odd directory.
        found.push({ path: slugPath, kind: 'directory' });
      }
    }
    for (const slug of await directories(scratchDir)) {
      const path = join(scratchDir, slug);
      if (!claimedSet.has(path) && !holdsClaimed(path)) {
        found.push({ path, kind: 'scratch' });
      }
    }
    return found;
  }

  private async describe(
    path: string,
    kind: OrphanedDirectory['kind'],
  ): Promise<OrphanedDirectory> {
    const result: OrphanedDirectory = {
      path,
      kind,
      branch: null,
      loss: null,
      error: null,
    };
    try {
      const contents = await this.entries.inspect(path, RULES[kind]);
      if (!contents) {
        result.error = 'It is gone';
        return result;
      }
      let loss: DirectoryLoss = {
        files: contents.files,
        fileCount: contents.fileCount,
        unpushedCommits: [],
        unpushedCount: 0,
        stashes: 0,
        bytes: contents.bytes,
        clean: contents.fileCount === 0,
      };
      if (contents.git) {
        result.branch = await this.git.currentBranch(path);
        const clone = await this.git.cloneLoss(path);
        loss = {
          files: clone.uncommittedFiles,
          fileCount: clone.uncommittedCount,
          unpushedCommits: clone.unpushedCommits,
          unpushedCount: clone.unpushedCount,
          stashes: clone.stashes,
          bytes: contents.bytes,
          clean:
            clone.uncommittedCount === 0 &&
            clone.unpushedCount === 0 &&
            clone.stashes === 0,
        };
      }
      result.loss = loss;
    } catch (error) {
      result.error = errorText(error);
    }
    return result;
  }

  private async missing(): Promise<MissingDirectory[]> {
    const missing: MissingDirectory[] = [];
    for (const session of this.records.list('include')) {
      if (session.status === 'preparing') {
        continue;
      }
      for (const directory of session.directories) {
        if (directory.state !== 'ready') {
          continue;
        }
        try {
          await lstat(directory.path);
        } catch {
          missing.push({
            sessionId: session.id,
            sessionTitle: session.title,
            position: directory.position,
            path: directory.path,
            name:
              directory.kind === 'scratch'
                ? 'Scratch'
                : (directory.repositoryName ?? directory.path),
          });
        }
      }
    }
    return missing;
  }

  /** `sessions/<slug>/<owner>` and `sessions/<slug>` once empty. */
  private async removeEmptyParents(path: string): Promise<void> {
    const rule = RULES.directory;
    const claimed = this.claimed();
    for (const parent of [dirname(path), dirname(dirname(path))]) {
      try {
        if (
          !claimed.some((other) => other.startsWith(`${parent}/`)) &&
          (await this.entries.verify(parent, rule)) &&
          (await readdir(parent)).length === 0
        ) {
          await rmdir(parent);
        }
      } catch {
        // not empty, gone, or not ours
      }
    }
  }
}
