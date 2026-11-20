import { readdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import type {
  ArchiveRequest,
  CleanupAction,
  CleanupChoice,
  CleanupDirectory,
  CleanupOutcome,
  CleanupPreview,
  CleanupResult,
  DeletionPreview,
  DirectoryLoss,
  RemoteBranchChoice,
  RemoteBranchOutcome,
  SessionDto,
} from '@claude-remote-manager/shared-types';
import { AttachmentStore } from '../attachments/attachment.store';
import { TranscriptReader } from '../agent/transcript-reader';
import { requireObject } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DATABASE, type AppDatabase } from '../db/database';
import { attachments, shownFiles } from '../db/schema';
import { GitService } from '../git/git.service';
import { KeyedMutex } from '../git/keyed-mutex';
import { PreviewsService } from '../previews/previews.service';
import {
  RepositoryRepository,
  type RepositoryRecord,
} from '../repositories/repository.repository';
import { ShownFilesService } from '../shown-files/shown-files.service';
import {
  cloneRule,
  scratchRule,
  WorkspaceEntries,
  type WorkspaceRule,
} from '../workspaces/workspace-entries';
import { cloneOfPull } from './session-clones';
import { SessionGitService } from './session-git.service';
import {
  parseRemoteBranchChoices,
  SessionRemoteBranches,
} from './session-remote-branches';
import {
  SessionRepository,
  type SessionDirectoryRecord,
  type SessionRecord,
  transcriptDirectory,
} from './session.repository';
import { SessionsService } from './sessions.service';
import { UsageRepository } from './usage.repository';

const ACTIONS: readonly CleanupAction[] = ['push', 'merge', 'discard', 'keep'];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Claude Code's configuration directory, as the session processes use it. */
export function claudeConfigDir(env = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
}

/** "3 uncommitted files, 2 commits not on the remote, 1 stash entry". */
export function describeLoss(loss: DirectoryLoss, scratch = false): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  if (loss.fileCount > 0) {
    parts.push(
      plural(
        loss.fileCount,
        scratch ? 'file' : 'uncommitted file',
        scratch ? 'files' : 'uncommitted files',
      ),
    );
  }
  if (loss.unpushedCount > 0) {
    parts.push(
      plural(
        loss.unpushedCount,
        'commit not on the remote',
        'commits not on the remote',
      ),
    );
  }
  if (loss.stashes > 0) {
    parts.push(plural(loss.stashes, 'stash entry', 'stash entries'));
  }
  return parts.join(', ') || 'nothing';
}

interface Described {
  directory: SessionDirectoryRecord;
  repository: RepositoryRecord | null;
  view: CleanupDirectory;
  /** Commits known to be on the remote (pushed, pull request heads). */
  known: string[];
  head: string | null;
}

/**
 * Managing sessions as a whole: cleaning up their clones and scratch
 * directories (push, merge into a local project, discard or keep; all of a
 * session's directories together), archiving and unarchiving, and deleting
 * a session for good. Nothing that holds work is removed unless the owner
 * saw what would be lost and accepted it. Directories are removed through
 * {@link WorkspaceEntries} only.
 */
@Injectable()
export class SessionManagementService {
  private readonly logger = new Logger(SessionManagementService.name);
  private readonly locks = new KeyedMutex();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: AppDatabase,
    private readonly sessions: SessionsService,
    private readonly records: SessionRepository,
    private readonly repositories: RepositoryRepository,
    private readonly sessionGit: SessionGitService,
    private readonly git: GitService,
    private readonly entries: WorkspaceEntries,
    private readonly usage: UsageRepository,
    private readonly transcripts: TranscriptReader,
    private readonly remoteBranches: SessionRemoteBranches,
    @Optional() private readonly attachmentStore?: AttachmentStore,
    @Optional() private readonly shownFileStore?: ShownFilesService,
    @Optional() private readonly previews?: PreviewsService,
  ) {}

  // --- Cleanup -------------------------------------------------------------

  /** What a cleanup would do and lose, per directory that exists. */
  async cleanupPreview(sessionId: string): Promise<CleanupPreview> {
    const record = this.require(sessionId);
    return {
      sessionId,
      blocked: this.cleanupBlocked(record, false),
      archiveBlocked: record.archivedAt
        ? 'The session is archived already'
        : this.cleanupBlocked(record, true),
      directories: (await this.describeAll(record)).map((entry) => entry.view),
      remoteBranches: await this.remoteBranches.describe(record),
      previews: this.previews?.forSession(sessionId).length ?? 0,
    };
  }

  /**
   * Cleans up the directories of an ended session as chosen; directories
   * not named are kept. Runs the choices one after another; a failure
   * (e.g. a push the remote refused) keeps that directory and goes on.
   */
  async cleanup(sessionId: string, request: unknown): Promise<CleanupResult> {
    const body = requireObject(request);
    const choices = parseChoices(body['directories']);
    const branches = parseRemoteBranchChoices(body['remoteBranches']);
    checkBranchChoices(choices, branches);
    return this.locks.run(sessionId, async () => {
      const record = this.require(sessionId);
      const blocked = this.cleanupBlocked(record, false);
      if (blocked) {
        throw new ConflictException(blocked);
      }
      const { outcomes, remoteBranches } = await this.runCleanup(
        record,
        choices,
        branches,
      );
      return {
        session: this.sessions.get(sessionId),
        outcomes,
        remoteBranches,
      };
    });
  }

  // --- Archive -------------------------------------------------------------

  /**
   * Archives a session: ends it (its process and dev servers stop), cleans
   * up its directories as chosen, and hides it from the default list. Its
   * history stays readable; unarchive to continue it (if its directories
   * still exist).
   */
  async archive(sessionId: string, request: unknown): Promise<CleanupResult> {
    const body = requireObject(request ?? {}) as ArchiveRequest &
      Record<string, unknown>;
    const choices =
      body['cleanup'] === undefined ? [] : parseChoices(body['cleanup']);
    const branches = parseRemoteBranchChoices(body['remoteBranches']);
    checkBranchChoices(choices, branches);
    return this.locks.run(sessionId, async () => {
      const record = this.require(sessionId);
      if (record.archivedAt) {
        throw new ConflictException('The session is archived already');
      }
      const blocked = this.cleanupBlocked(record, true);
      if (blocked) {
        throw new ConflictException(blocked);
      }
      if (record.status !== 'finished') {
        await this.sessions.end(sessionId);
      }
      const { outcomes, remoteBranches } = await this.runCleanup(
        this.require(sessionId),
        choices,
        branches,
      );
      this.sessions.recordEvent(sessionId, {
        type: 'notice',
        level: 'info',
        text: 'The session was archived.',
      });
      const session = this.sessions.setArchived(sessionId, new Date());
      return { session, outcomes, remoteBranches };
    });
  }

  /** Shows an archived session in the default list again. */
  unarchive(sessionId: string): SessionDto {
    const record = this.require(sessionId);
    if (!record.archivedAt) {
      return this.sessions.get(sessionId);
    }
    this.sessions.recordEvent(sessionId, {
      type: 'notice',
      level: 'info',
      text: 'The session was unarchived.',
    });
    return this.sessions.setArchived(sessionId, null);
  }

  // --- Delete --------------------------------------------------------------

  /** What deleting the session removes (and what stays). */
  async deletionPreview(sessionId: string): Promise<DeletionPreview> {
    const record = this.require(sessionId);
    const countOf = (table: typeof attachments | typeof shownFiles): number =>
      this.db
        .select({ n: count() })
        .from(table)
        .where(eq(table.sessionId, sessionId))
        .get()?.n ?? 0;
    let transcript = false;
    try {
      const cwd = transcriptDirectory(record);
      transcript =
        !!cwd &&
        (await this.transcripts.exists(
          record.sdkSessionId ?? record.id,
          cwd,
          record.workingDirectory !== null,
        ));
    } catch {
      transcript = false;
    }
    return {
      sessionId,
      blocked: this.deletionBlocked(record),
      directories: (await this.describeAll(record)).map((entry) => entry.view),
      transcript,
      attachments: countOf(attachments),
      shownFiles: countOf(shownFiles),
      pullRequests: record.pullRequests.length,
      usage: this.usage.totalsForSession(sessionId),
    };
  }

  /**
   * Deletes a session for good: its directories, Claude Code's transcript
   * and other files of the session, attached images, snapshots of shown
   * files, its events and search entries. Its usage stays in the
   * statistics, with title and repositories. Only for ended or archived
   * sessions, after `confirm`; directories with work that would be lost
   * need `acceptLoss` too.
   */
  async delete(sessionId: string, request: unknown): Promise<void> {
    const body = requireObject(request);
    if (body['confirm'] !== true) {
      throw new BadRequestException(
        'Deleting a session needs confirm: true (after showing what is lost)',
      );
    }
    const acceptLoss = body['acceptLoss'] === true;
    await this.locks.run(sessionId, async () => {
      const record = this.require(sessionId);
      const blocked = this.deletionBlocked(record);
      if (blocked) {
        throw new ConflictException(blocked);
      }
      const described = await this.describeAll(record);
      const dirty = described.filter(
        (entry) => entry.view.loss === null || !entry.view.loss.clean,
      );
      if (dirty.length > 0 && !acceptLoss) {
        throw new ConflictException(
          `Deleting would lose work in ${dirty.map((entry) => entry.view.name).join(', ')}; confirm the loss (acceptLoss)`,
        );
      }
      await this.previews
        ?.stopSession(sessionId)
        .catch((error: unknown) =>
          this.logger.warn(
            `Stopping the previews of ${sessionId} failed: ${errorText(error)}`,
          ),
        );
      for (const entry of described) {
        if (entry.view.kind === 'directory') {
          continue; // not the app's: never deleted
        }
        await this.removeDirectory(record, entry.directory);
      }
      await this.removeEmptyParents(record);
      const ids = new Set([record.id, record.sdkSessionId].filter(Boolean));
      // Also the copy in an earlier version's configuration directory.
      const configDirs = [
        claudeConfigDir(),
        ...(this.config.legacyClaudeConfigDir
          ? [this.config.legacyClaudeConfigDir]
          : []),
      ];
      for (const id of ids) {
        for (const configDir of configDirs) {
          await this.entries.removeClaudeSessionData(configDir, id as string);
        }
      }
      await this.attachmentStore?.removeSession(sessionId);
      await this.shownFileStore?.removeSession(sessionId);
      this.records.delete(sessionId);
      this.sessions.forget(sessionId);
      this.logger.log(`Session ${sessionId} was deleted`);
    });
  }

  // -------------------------------------------------------------------------

  private require(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (!record) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return record;
  }

  /**
   * Why the session cannot be cleaned up now. For archiving, a session
   * that waits is ended first; otherwise it must be ended already.
   */
  private cleanupBlocked(
    record: SessionRecord,
    archiving: boolean,
  ): string | null {
    const busy = this.sessions.busyReason(record.id);
    if (busy) {
      return busy;
    }
    const session = this.sessions.get(record.id);
    if (session.waitingFor === 'permission') {
      return 'Claude waits for an answer in a running turn; answer or stop it first';
    }
    if (
      !archiving &&
      record.status !== 'finished' &&
      record.status !== 'failed'
    ) {
      return 'End the session before cleaning up its clones';
    }
    return null;
  }

  private deletionBlocked(record: SessionRecord): string | null {
    const busy = this.sessions.busyReason(record.id);
    if (busy) {
      return busy;
    }
    if (
      !record.archivedAt &&
      record.status !== 'finished' &&
      record.status !== 'failed'
    ) {
      return 'Only ended or archived sessions can be deleted; end or archive it first';
    }
    return null;
  }

  private async describeAll(record: SessionRecord): Promise<Described[]> {
    const ready = record.directories.filter(
      (directory) => directory.state === 'ready',
    );
    const described: Described[] = [];
    for (const directory of ready) {
      described.push(await this.describe(record, directory));
    }
    return described;
  }

  private async describe(
    record: SessionRecord,
    directory: SessionDirectoryRecord,
  ): Promise<Described> {
    const base: CleanupDirectory = {
      position: directory.position,
      kind: directory.kind,
      name:
        directory.kind === 'scratch'
          ? 'Scratch'
          : (directory.repositoryName ?? directory.path),
      repositoryId: directory.repositoryId,
      path: directory.path,
      branch: directory.branch,
      baseBranch: directory.baseBranch,
      actions: ['keep'],
      hasCommits: false,
      loss: null,
      lossAfterIntegration: null,
      error: null,
    };
    if (directory.kind === 'directory') {
      base.error =
        'A directory from before session clones; it is not the app’s to remove';
      return { directory, repository: null, view: base, known: [], head: null };
    }
    if (directory.kind === 'scratch') {
      base.actions = ['discard', 'keep'];
      try {
        base.loss = await this.scratchLoss(record, directory);
        if (!base.loss) {
          base.error = 'The directory is gone';
        }
      } catch (error) {
        base.error = errorText(error);
      }
      return { directory, repository: null, view: base, known: [], head: null };
    }
    const repository = directory.repositoryId
      ? (this.repositories.get(directory.repositoryId) ?? null)
      : null;
    base.actions = [
      ...(repository && directory.branch
        ? [
            repository.cloneUrl === null
              ? ('merge' as const)
              : ('push' as const),
          ]
        : []),
      'discard',
      'keep',
    ];
    const known = [
      ...record.pullRequests
        .filter(
          (pull) =>
            cloneOfPull(record.directories, pull)?.position ===
            directory.position,
        )
        .flatMap((pull) => (pull.headSha ? [pull.headSha] : [])),
      ...(directory.pushedCommit ? [directory.pushedCommit] : []),
    ];
    let head: string | null = null;
    try {
      if (
        !(await this.entries.verify(directory.path, cloneRule(record.slug)))
      ) {
        base.error = 'The clone is gone';
        return { directory, repository, view: base, known, head };
      }
      head = directory.branch
        ? await this.git.localBranchCommit(directory.path, directory.branch)
        : null;
      base.hasCommits = head !== null && head !== directory.baseCommit;
      const bytes = await this.entries
        .diskUsage(directory.path, cloneRule(record.slug))
        .catch(() => null);
      base.loss = {
        ...toLoss(
          await this.git.cloneLoss(directory.path, {
            knownRemoteCommits: known,
          }),
        ),
        bytes,
      };
      if (base.hasCommits && head) {
        base.lossAfterIntegration = {
          ...toLoss(
            await this.git.cloneLoss(directory.path, {
              knownRemoteCommits: [...known, head],
            }),
          ),
          bytes,
        };
      }
    } catch (error) {
      base.error = errorText(error);
      base.loss = null;
    }
    return { directory, repository, view: base, known, head };
  }

  private async scratchLoss(
    record: SessionRecord,
    directory: SessionDirectoryRecord,
  ): Promise<DirectoryLoss | null> {
    const contents = await this.entries.inspect(
      directory.path,
      scratchRule(record.slug),
    );
    return contents
      ? {
          files: contents.files,
          fileCount: contents.fileCount,
          unpushedCommits: [],
          unpushedCount: 0,
          stashes: 0,
          bytes: contents.bytes,
          clean: contents.fileCount === 0,
        }
      : null;
  }

  /**
   * Runs the directories' choices, then deletes the chosen remote branches
   * (afterwards: a clone is discarded checked against the remote as it was).
   */
  private async runCleanup(
    record: SessionRecord,
    choices: CleanupChoice[],
    branches: RemoteBranchChoice[],
  ): Promise<{
    outcomes: CleanupOutcome[];
    remoteBranches: RemoteBranchOutcome[];
  }> {
    if (choices.length === 0 && branches.length === 0) {
      return { outcomes: [], remoteBranches: [] };
    }
    const described = choices.length > 0 ? await this.describeAll(record) : [];
    const outcomes: CleanupOutcome[] = [];
    for (const choice of choices) {
      const entry = described.find(
        (item) => item.directory.position === choice.position,
      );
      if (!entry) {
        outcomes.push({
          position: choice.position,
          name: `Directory ${choice.position}`,
          action: choice.action,
          result: 'failed',
          message: 'The session has no such directory that exists',
        });
        continue;
      }
      outcomes.push(await this.cleanupOne(record, entry, choice));
    }
    const remoteBranches =
      branches.length > 0
        ? await this.remoteBranches.delete(this.require(record.id), branches)
        : [];
    const removed = outcomes.filter((outcome) => outcome.result === 'removed');
    if (removed.length > 0) {
      await this.removeEmptyParents(record);
      await this.previews
        ?.stopSession(record.id)
        .catch((error: unknown) =>
          this.logger.warn(
            `Stopping the previews of ${record.id} failed: ${errorText(error)}`,
          ),
        );
    }
    const done = outcomes.filter(
      (outcome) => outcome.action !== 'keep' || outcome.result !== 'kept',
    );
    const lines = [...done, ...remoteBranches].map(
      (outcome) => `${outcome.name}: ${outcome.message}`,
    );
    if (lines.length > 0) {
      this.sessions.recordEvent(record.id, {
        type: 'notice',
        level: [...outcomes, ...remoteBranches].some(
          (outcome) => outcome.result === 'failed',
        )
          ? 'warning'
          : 'info',
        text: `Cleanup: ${lines.join('; ')}.${removed.length > 0 ? ' The session can be read but no longer continued.' : ''}`,
      });
    }
    this.sessions.publishUpdate(record.id);
    return { outcomes, remoteBranches };
  }

  private async cleanupOne(
    record: SessionRecord,
    entry: Described,
    choice: CleanupChoice,
  ): Promise<CleanupOutcome> {
    const { directory, view, repository } = entry;
    const outcome = (
      result: CleanupOutcome['result'],
      message: string,
    ): CleanupOutcome => ({
      position: directory.position,
      name: view.name,
      action: choice.action,
      result,
      message,
    });
    if (choice.action === 'keep') {
      return outcome('kept', 'kept');
    }
    if (!view.actions.includes(choice.action)) {
      return outcome('failed', `${choice.action} is not possible here; kept`);
    }
    const known = [...entry.known];
    const steps: string[] = [];
    if (choice.action === 'push' && repository && directory.repositoryId) {
      if (view.hasCommits) {
        try {
          const commit = await this.sessionGit.push(
            record.id,
            directory.repositoryId,
            directory.branch,
          );
          known.push(commit);
          steps.push(`pushed ${directory.branch} (${commit.slice(0, 7)})`);
        } catch (error) {
          return outcome(
            'failed',
            `push failed (${errorText(error)}); the clone was kept`,
          );
        }
      } else {
        steps.push('nothing to push');
      }
    }
    if (choice.action === 'merge' && repository && directory.branch) {
      const target = directory.baseBranch ?? 'main';
      if (view.hasCommits) {
        try {
          const commit = await this.git.fastForwardMirror({
            mirrorPath: repository.localPath,
            clonePath: directory.path,
            sourceBranch: directory.branch,
            targetBranch: target,
          });
          known.push(commit);
          steps.push(`fast-forwarded ${target} to ${commit.slice(0, 7)}`);
        } catch (error) {
          return outcome(
            'failed',
            `${target} could not be fast-forwarded (${errorText(error)}): merge ${target} into the session branch first; the clone was kept`,
          );
        }
      } else {
        steps.push('nothing to merge');
      }
    }
    // What would be lost now, read again right before removing.
    let loss: DirectoryLoss | null;
    try {
      loss =
        directory.kind === 'scratch'
          ? await this.scratchLoss(record, directory)
          : toLoss(
              await this.git.cloneLoss(directory.path, {
                knownRemoteCommits: known,
              }),
            );
    } catch (error) {
      return outcome(
        'failed',
        [
          ...steps,
          `could not check what it holds (${errorText(error)}); kept`,
        ].join(', '),
      );
    }
    if (!loss || (!loss.clean && choice.acceptLoss !== true)) {
      return outcome(
        'kept',
        [
          ...steps,
          `kept: it still has ${loss ? describeLoss(loss, directory.kind === 'scratch') : 'unknown content'}`,
        ].join(', '),
      );
    }
    try {
      await this.removeDirectory(record, directory);
    } catch (error) {
      return outcome(
        'failed',
        [...steps, `could not be removed (${errorText(error)})`].join(', '),
      );
    }
    return outcome(
      'removed',
      [
        ...steps,
        loss.clean
          ? 'removed'
          : `removed (lost ${describeLoss(loss, directory.kind === 'scratch')})`,
      ].join(', '),
    );
  }

  private async removeDirectory(
    record: SessionRecord,
    directory: SessionDirectoryRecord,
  ): Promise<void> {
    const rule: WorkspaceRule =
      directory.kind === 'scratch'
        ? scratchRule(record.slug)
        : cloneRule(record.slug);
    await this.entries.remove(
      directory.path,
      rule,
      this.records.directoryPathsExcept(record.id),
    );
    this.records.updateDirectory(record.id, directory.position, {
      state: 'removed',
    });
  }

  /** Removes `sessions/<slug>/<owner>` and `sessions/<slug>` once empty. */
  private async removeEmptyParents(record: SessionRecord): Promise<void> {
    if (!record.slug) {
      return;
    }
    const root = join(this.config.sessionsDir, record.slug);
    const owners = new Set(
      record.directories
        .filter((directory) => directory.kind === 'clone')
        .map((directory) => dirname(directory.path)),
    );
    const rule: WorkspaceRule = {
      area: 'sessions',
      depths: [1, 2],
      slug: record.slug,
    };
    for (const path of [...owners, root]) {
      try {
        if (
          (await this.entries.verify(path, rule)) &&
          (await readdir(path)).length === 0
        ) {
          // rmdir removes only an empty directory and follows no link.
          await rmdir(path);
        }
      } catch {
        // gone, not empty, or not the session's
      }
    }
  }
}

function toLoss(loss: {
  uncommittedFiles: string[];
  uncommittedCount: number;
  unpushedCommits: { branch: string; sha: string; subject: string }[];
  unpushedCount: number;
  stashes: number;
}): DirectoryLoss {
  return {
    files: loss.uncommittedFiles,
    fileCount: loss.uncommittedCount,
    unpushedCommits: loss.unpushedCommits,
    unpushedCount: loss.unpushedCount,
    stashes: loss.stashes,
    bytes: null,
    clean:
      loss.uncommittedCount === 0 &&
      loss.unpushedCount === 0 &&
      loss.stashes === 0,
  };
}

/**
 * A branch is not deleted on the remote where its clone is pushed in the
 * same cleanup: that would undo the push at once.
 */
function checkBranchChoices(
  choices: CleanupChoice[],
  branches: RemoteBranchChoice[],
): void {
  for (const branch of branches) {
    if (
      choices.some(
        (choice) =>
          choice.position === branch.position && choice.action === 'push',
      )
    ) {
      throw new BadRequestException(
        'A branch cannot be pushed and deleted on the remote in the same cleanup',
      );
    }
  }
}

function parseChoices(value: unknown): CleanupChoice[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new BadRequestException('directories must be a list of choices');
  }
  const seen = new Set<number>();
  return value.map((item: unknown) => {
    const entry = requireObject(item);
    const position = entry['position'];
    const action = entry['action'];
    if (
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0 ||
      seen.has(position)
    ) {
      throw new BadRequestException('position must be a directory position');
    }
    seen.add(position);
    if (!ACTIONS.includes(action as CleanupAction)) {
      throw new BadRequestException(
        `action must be one of ${ACTIONS.join(', ')}`,
      );
    }
    if (
      entry['acceptLoss'] !== undefined &&
      typeof entry['acceptLoss'] !== 'boolean'
    ) {
      throw new BadRequestException('acceptLoss must be a boolean');
    }
    return {
      position,
      action: action as CleanupAction,
      acceptLoss: entry['acceptLoss'] === true,
    };
  });
}
