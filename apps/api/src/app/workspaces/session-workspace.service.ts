import { randomUUID } from 'node:crypto';
import { mkdir, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type {
  CreateSessionRequest,
  RepositoryAddedBy,
  SessionEventInput,
  SetupResultEvent,
  SetupStatus,
} from '@claude-remote-manager/shared-types';
import {
  EnvironmentFiles,
  type WrittenFiles,
} from '../environments/environment-files';
import {
  EnvironmentsService,
  type LaunchEnvironment,
} from '../environments/environments.service';
import {
  isUuid,
  optionalString,
  requireObject,
  requireString,
} from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  analyzeGitPushes,
  type GitPushAnalysis,
} from '../agent/git-push-analysis';
import { handOverToSession } from '../common/ownership';
import { isGitPushCommand } from '../sessions/app-tools';
import { GitService, isValidBranchName } from '../git/git.service';
import { newSlug } from '../git/slug';
import { RepositoriesService } from '../repositories/repositories.service';
import type { RepositoryRecord } from '../repositories/repository.repository';
import {
  SessionRepository,
  type NewSessionDirectory,
  type SessionDirectoryRecord,
  type SessionRecord,
  workingDirectory as workingDirectoryOf,
} from '../sessions/session.repository';
import { SettingsService } from '../settings/settings.service';
import { cloneRule, scratchRule, WorkspaceEntries } from './workspace-entries';
import { SetupScriptRunner } from './setup-script-runner';

/** Repositories a session may have. */
export const MAX_SESSION_REPOSITORIES = 10;
const SLUG_ATTEMPTS = 10;

/** Directories of a new session, checked and with a unique slug. */
export interface WorkspacePlan {
  slug: string;
  directories: NewSessionDirectory[];
}

/** Outcome of the setup scripts. */
export interface SetupOutcome {
  /** A setup script failed or timed out (not: was stopped by ending). */
  failed: string[];
}

/** How preparing an added repository ended. */
export type AdditionOutcome =
  | { state: 'ready'; directory: SessionDirectoryRecord }
  | {
      state: 'failed' | 'held';
      error: string;
      directory: SessionDirectoryRecord | null;
    };

/** Preparation failed; the session's directories were removed again. */
export class PreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreparationError';
  }
}

type Emit = (event: SessionEventInput) => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Age of a point in time in words, e.g. `5 minutes`, `3 hours`. */
export function ageInWords(since: Date, now = new Date()): string {
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - since.getTime()) / 60_000),
  );
  const plural = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? '' : 's'}`;
  if (minutes < 60) {
    return plural(minutes, 'minute');
  }
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? plural(hours, 'hour')
    : plural(Math.round(hours / 24), 'day');
}

const isClone = (directory: SessionDirectoryRecord) =>
  directory.kind === 'clone' && directory.repositoryId !== null;

/**
 * Plans and prepares the directories of sessions: one clone per repository
 * (made from its mirror) on the session branch `claude/<slug>`, or a
 * scratch directory, and the repositories' setup scripts. If a clone cannot
 * be created, the session's other directories are removed again and the
 * session gets a clear error.
 */
@Injectable()
export class SessionWorkspaceService {
  private readonly logger = new Logger(SessionWorkspaceService.name);
  private workspaceEntries: WorkspaceEntries | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionRepository,
    private readonly repositories: RepositoriesService,
    private readonly git: GitService,
    private readonly setup: SetupScriptRunner,
    private readonly settings: SettingsService,
    @Optional()
    private readonly environments?: EnvironmentsService,
    @Optional()
    private readonly environmentFiles?: EnvironmentFiles,
  ) {}

  /**
   * What the `git push` commands in a shell command would update, judged
   * against the session's branches and what its clones have checked out.
   */
  async analyzeGitPushes(
    sessionId: string,
    command: string,
  ): Promise<GitPushAnalysis[]> {
    if (!isGitPushCommand(command)) {
      return [];
    }
    const session = this.sessions.require(sessionId);
    const clones = session.directories.filter(
      (directory) => directory.kind === 'clone' && directory.state === 'ready',
    );
    const branches = clones.flatMap((directory) =>
      directory.branch ? [directory.branch] : [],
    );
    const checkedOut: string[] = [];
    for (const directory of clones) {
      const branch = await this.git.currentBranch(directory.path);
      if (branch) {
        checkedOut.push(branch);
      }
    }
    return analyzeGitPushes(command, branches, checkedOut);
  }

  /**
   * Writes the configured commit identity into every session clone that
   * exists and has another one; at startup, as the identity comes from the
   * environment. Returns the number of clones updated.
   */
  async applyIdentity(): Promise<number> {
    const identity = this.settings.gitIdentity();
    let updated = 0;
    for (const path of this.sessions.readyClonePaths()) {
      try {
        if (
          (await exists(path)) &&
          !(await this.git.hasIdentity(path, identity))
        ) {
          await this.git.setIdentity(path, identity);
          updated++;
        }
      } catch (error) {
        this.logger.warn(
          `Could not set the commit identity in ${path}: ${errorText(error)}`,
        );
      }
    }
    return updated;
  }

  /**
   * Validates the workspace part of a session request and picks a slug
   * that no session or directory uses yet. Its only side effect: a
   * requested new project is registered.
   */
  async plan(request: CreateSessionRequest): Promise<WorkspacePlan> {
    const body = requireObject(request);
    const selections = this.parseRepositories(body['repositories']);
    const projectName = this.parseProject(body['newProject']);
    const scratch = body['scratch'];
    if (
      scratch !== undefined &&
      scratch !== null &&
      typeof scratch !== 'boolean'
    ) {
      throw new BadRequestException('scratch must be a boolean');
    }
    if (scratch && (projectName !== null || selections.length > 0)) {
      throw new BadRequestException(
        'A scratch session has no repositories or project',
      );
    }
    if (!scratch && projectName === null && selections.length === 0) {
      throw new BadRequestException(
        'Choose a main repository, a new project or a scratch directory',
      );
    }
    if (!scratch) {
      // Commits in session clones are made as the user; never start
      // without an identity.
      this.settings.requireGitIdentity();
    }
    const repositories = selections.map(({ repositoryId, baseBranch }) => {
      let record: RepositoryRecord;
      try {
        record = this.repositories.require(repositoryId);
      } catch {
        throw new BadRequestException(`Repository ${repositoryId} not found`);
      }
      return { record, baseBranch };
    });

    const slug = await this.uniqueSlug();
    if (scratch) {
      return {
        slug,
        directories: [
          {
            path: join(this.config.scratchDir, slug),
            kind: 'scratch',
            repositoryId: null,
            branch: null,
            baseBranch: null,
            state: 'pending',
            setupStatus: 'none',
          },
        ],
      };
    }
    if (projectName !== null) {
      repositories.unshift({
        record: this.repositories.createProject(projectName),
        baseBranch: null,
      });
    }
    return {
      slug,
      directories: repositories.map(({ record, baseBranch }) => ({
        path: this.clonePath(record, slug),
        kind: 'clone',
        repositoryId: record.id,
        branch: `claude/${slug}`,
        baseBranch,
        state: 'pending',
        setupStatus: record.setupScript ? 'pending' : 'none',
      })),
    };
  }

  /**
   * Creates the session's directories and runs the setup scripts. Throws a
   * {@link PreparationError} after rolling back if a directory could not
   * be created. Aborting skips the setup scripts that have not finished.
   */
  async prepare(
    sessionId: string,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<SetupOutcome> {
    const session = this.sessions.require(sessionId);
    const pending = session.directories.filter(
      (directory) => directory.state === 'pending',
    );
    const results = await Promise.allSettled(
      pending.map((directory) =>
        directory.kind === 'scratch'
          ? this.createScratch(session, directory, emit)
          : this.createClone(session, directory, emit),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [errorText(result.reason)] : [],
    );
    if (failures.length > 0) {
      await this.rollback(sessionId, emit);
      throw new PreparationError(
        `${failures.join('; ')}. The session's other directories were removed again.`,
      );
    }
    return this.runSetupScripts(
      sessionId,
      emit,
      signal,
      () => true,
      (status) => status === 'pending',
    );
  }

  /** Runs the setup scripts that failed or timed out once more. */
  rerunFailedSetup(
    sessionId: string,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<SetupOutcome> {
    return this.runSetupScripts(
      sessionId,
      emit,
      signal,
      (directory) =>
        directory.setupStatus === 'failed' ||
        directory.setupStatus === 'timed_out',
      (status) => status === 'failed' || status === 'timed_out',
    );
  }

  /**
   * Removes everything a failed or interrupted preparation created: the
   * session's clones and scratch directory. Directories end as `removed`,
   * or `failed` if they were never created.
   */
  async rollback(
    sessionId: string,
    emit: Emit = () => undefined,
  ): Promise<void> {
    const session = this.sessions.require(sessionId);
    for (const directory of session.directories) {
      if (
        (directory.state !== 'pending' && directory.state !== 'ready') ||
        directory.kind === 'directory'
      ) {
        continue;
      }
      // Paths contain the session's unique slug: nobody else created them.
      const created = await exists(directory.path);
      try {
        await this.entries.remove(
          directory.path,
          directory.kind === 'scratch'
            ? scratchRule(session.slug)
            : cloneRule(session.slug),
        );
        await this.removeEmptyParents(directory.path);
        this.sessions.updateDirectory(sessionId, directory.position, {
          state: directory.state === 'ready' ? 'removed' : 'failed',
          setupStatus:
            directory.setupStatus === 'pending'
              ? 'skipped'
              : directory.setupStatus,
        });
        if (created) {
          emit(
            progress(
              'rollback',
              'succeeded',
              directory.repositoryName,
              directory.path,
              'Removed',
            ),
          );
        }
      } catch (error) {
        this.logger.error(
          `Rolling back ${directory.path} of session ${sessionId} failed: ${errorText(error)}`,
        );
        this.sessions.updateDirectory(sessionId, directory.position, {
          state: 'failed',
        });
        emit(
          progress(
            'rollback',
            'failed',
            directory.repositoryName,
            directory.path,
            errorText(error),
          ),
        );
      }
    }
  }

  /**
   * Adds a registered repository to a session that exists already: checks
   * it like the new-session form does (commit identity, the repository,
   * the base branch, the limit) and that it is not part of the session
   * yet, then records its clone `sessions/<slug>/<owner>/<name>` on the
   * session branch as `pending` (addition `preparing`). Nothing is on disk
   * yet; {@link prepareAddition} makes the clone.
   */
  planAddition(
    sessionId: string,
    repositoryId: string,
    baseBranch: string | null,
    by: RepositoryAddedBy,
  ): SessionDirectoryRecord {
    const session = this.sessions.require(sessionId);
    if (!session.slug) {
      throw new ConflictException(
        'This session was created before session clones; start a new session to add repositories',
      );
    }
    if (!isUuid(repositoryId)) {
      throw new BadRequestException('repositoryId must be a UUID');
    }
    if (baseBranch !== null && !isValidBranchName(baseBranch)) {
      throw new BadRequestException('baseBranch is not a valid branch name');
    }
    this.settings.requireGitIdentity();
    let repository: RepositoryRecord;
    try {
      repository = this.repositories.require(repositoryId);
    } catch {
      throw new BadRequestException(`Repository ${repositoryId} not found`);
    }
    const name = `${repository.owner}/${repository.name}`;
    const existing = session.directories.find(
      (directory) => directory.repositoryId === repositoryId,
    );
    if (existing) {
      throw new ConflictException(
        existing.addition && existing.addition.state !== 'ready'
          ? `${name} is already being added to this session; retry or remove it in the session details`
          : `${name} is already part of this session`,
      );
    }
    const clones = session.directories.filter(isClone);
    if (clones.length >= MAX_SESSION_REPOSITORIES) {
      throw new BadRequestException(
        `A session can have at most ${MAX_SESSION_REPOSITORIES} repositories`,
      );
    }
    const path = this.clonePath(repository, session.slug);
    if (session.directories.some((directory) => directory.path === path)) {
      throw new ConflictException(
        `The session has a directory at ${path} already`,
      );
    }
    try {
      return this.sessions.addDirectory(sessionId, {
        path,
        repositoryId,
        branch: `claude/${session.slug}`,
        baseBranch,
        setupStatus: repository.setupScript ? 'pending' : 'none',
        addedBy: by,
      });
    } catch (error) {
      if (
        String((error as { code?: unknown }).code).startsWith(
          'SQLITE_CONSTRAINT',
        )
      ) {
        throw new ConflictException(`${name} is already part of this session`);
      }
      throw error;
    }
  }

  /**
   * Adds a further clone of a repository the session has already, on a
   * branch of its own for a further pull request in parallel (tool
   * `add_branch`): `claude/<slug>-2`, `-3`, … (numbered, no content in
   * the name) at `sessions/<slug>/<owner>/<name>-2`, from the base branch of
   * the repository's first clone unless another is named. Recorded as an
   * addition like {@link planAddition}; {@link prepareAddition} makes the
   * clone from the freshly fetched mirror. Local projects without remote
   * are refused (their branches never reach a pull request).
   */
  planBranchAddition(
    sessionId: string,
    repositoryId: string,
    baseBranch: string | null,
    by: RepositoryAddedBy,
  ): SessionDirectoryRecord {
    const session = this.sessions.require(sessionId);
    if (!session.slug) {
      throw new ConflictException(
        'This session was created before session clones; start a new session to add branches',
      );
    }
    if (baseBranch !== null && !isValidBranchName(baseBranch)) {
      throw new BadRequestException('baseBranch is not a valid branch name');
    }
    this.settings.requireGitIdentity();
    let repository: RepositoryRecord;
    try {
      repository = this.repositories.require(repositoryId);
    } catch {
      throw new BadRequestException(`Repository ${repositoryId} not found`);
    }
    const name = `${repository.owner}/${repository.name}`;
    const first = session.directories.find(
      (directory) =>
        directory.kind === 'clone' && directory.repositoryId === repositoryId,
    );
    if (!first) {
      throw new ConflictException(
        `${name} is not part of this session; add the repository first`,
      );
    }
    if (repository.cloneUrl === null) {
      throw new ConflictException(
        `${name} is a local project without remote: a further branch could not become a pull request`,
      );
    }
    if (
      session.directories.some(
        (directory) =>
          directory.addition &&
          directory.addition.state !== 'ready' &&
          directory.state !== 'removed',
      )
    ) {
      throw new ConflictException(
        'A repository or branch is being added to this session, or its addition failed; retry or remove it in the session details first',
      );
    }
    const clones = session.directories.filter(
      (directory) => isClone(directory) && directory.state !== 'removed',
    );
    if (clones.length >= MAX_SESSION_REPOSITORIES) {
      throw new BadRequestException(
        `A session can have at most ${MAX_SESSION_REPOSITORIES} clones`,
      );
    }
    // Numbers are never reused: a removed clone's branch may still be on
    // GitHub (its pull request's head).
    const branches = new Set(
      session.directories.map((directory) => directory.branch),
    );
    const paths = new Set(
      session.directories.map((directory) => directory.path),
    );
    const base = this.clonePath(repository, session.slug);
    let number = 2;
    while (
      branches.has(`claude/${session.slug}-${number}`) ||
      paths.has(`${base}-${number}`)
    ) {
      number++;
    }
    return this.sessions.addDirectory(sessionId, {
      path: `${base}-${number}`,
      repositoryId,
      branch: `claude/${session.slug}-${number}`,
      baseBranch: baseBranch ?? first.baseBranch,
      setupStatus: repository.setupScript ? 'pending' : 'none',
      addedBy: by,
    });
  }

  /**
   * Prepares a repository added to a running session like the session's
   * own: fetches the mirror, makes the clone on the session branch and
   * runs the repository's setup script. A clone that cannot be made is
   * removed again (`failed`, nothing left on disk); a setup script that
   * fails or times out keeps the clone but holds it back from Claude
   * (`held`). Every event carries `additionId`.
   */
  async prepareAddition(
    sessionId: string,
    position: number,
    additionId: string,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<AdditionOutcome> {
    const tagged = tagAddition(emit, additionId);
    let session = this.sessions.require(sessionId);
    let directory = session.directories.find(
      (entry) => entry.position === position,
    );
    if (!directory?.addition) {
      throw new Error(`No repository is being added at position ${position}`);
    }
    if (directory.state !== 'ready') {
      try {
        await this.createClone(session, directory, tagged);
      } catch (error) {
        const message = errorText(error);
        await this.removeAddedClone(session, directory);
        session = this.sessions.updateDirectory(sessionId, position, {
          state: 'failed',
          additionState: 'failed',
          additionError: message,
          setupStatus: directory.setupStatus === 'none' ? 'none' : 'pending',
        });
        return {
          state: 'failed',
          error: message,
          directory: this.directoryAt(session, position),
        };
      }
    }
    await this.runSetupScripts(
      sessionId,
      tagged,
      signal,
      (entry) => entry.position === position,
    );
    session = this.sessions.require(sessionId);
    directory = this.directoryAt(session, position);
    if (
      directory.setupStatus === 'none' ||
      directory.setupStatus === 'succeeded'
    ) {
      session = this.sessions.updateDirectory(sessionId, position, {
        additionState: 'ready',
        additionError: null,
      });
      return { state: 'ready', directory: this.directoryAt(session, position) };
    }
    const error = signal.aborted
      ? 'The setup script was stopped because the session was ended'
      : directory.setupStatus === 'timed_out'
        ? 'The setup script timed out'
        : 'The setup script failed';
    session = this.sessions.updateDirectory(sessionId, position, {
      additionState: 'held',
      additionError: error,
    });
    return {
      state: 'held',
      error,
      directory: this.directoryAt(session, position),
    };
  }

  /**
   * Marks a failed or held addition as being prepared again (the user
   * retries): a failed one is cloned again, a held one runs its setup
   * script again.
   */
  beginRetry(sessionId: string, position: number): SessionDirectoryRecord {
    const directory = this.directoryAt(
      this.sessions.require(sessionId),
      position,
    );
    const state = directory.addition?.state;
    if (state !== 'failed' && state !== 'held') {
      throw new ConflictException(
        'Only a repository whose addition failed or is held can be retried',
      );
    }
    this.settings.requireGitIdentity();
    return this.directoryAt(
      this.sessions.updateDirectory(sessionId, position, {
        ...(state === 'failed' ? { state: 'pending' as const } : {}),
        additionState: 'preparing',
        additionError: null,
      }),
      position,
    );
  }

  /**
   * Lets Claude have an added repository whose setup script failed (the
   * user decided to use it anyway).
   */
  acceptHeldAddition(
    sessionId: string,
    position: number,
  ): SessionDirectoryRecord {
    const directory = this.directoryAt(
      this.sessions.require(sessionId),
      position,
    );
    if (directory.addition?.state !== 'held' || directory.state !== 'ready') {
      throw new ConflictException(
        'Only a repository whose setup script failed can be used anyway',
      );
    }
    return this.directoryAt(
      this.sessions.updateDirectory(sessionId, position, {
        additionState: 'ready',
        additionError: null,
      }),
      position,
    );
  }

  /**
   * Removes a repository that was added to the running session but never
   * became part of it (`failed` or `held`): its clone, the then empty
   * owner directory, and its row. Removing a repository Claude works in
   * is not supported.
   */
  async removeAddition(sessionId: string, position: number): Promise<void> {
    const session = this.sessions.require(sessionId);
    const directory = this.directoryAt(session, position);
    if (
      !directory.addition ||
      (directory.addition.state !== 'failed' &&
        directory.addition.state !== 'held')
    ) {
      throw new ConflictException(
        'Only a repository whose addition failed or is held can be removed',
      );
    }
    await this.removeAddedClone(session, directory);
    this.sessions.deleteAddedDirectory(sessionId, position);
  }

  /**
   * After a server stop during an addition: its clone is removed again and
   * the addition is marked failed, so the user can retry or remove it.
   */
  async rollbackInterruptedAdditions(
    emit: (sessionId: string, event: SessionEventInput) => void,
  ): Promise<void> {
    for (const { sessionId, position } of this.sessions.preparingAdditions()) {
      const session = this.sessions.require(sessionId);
      const directory = this.directoryAt(session, position);
      const message =
        'Adding the repository was interrupted because the server stopped';
      try {
        await this.removeAddedClone(session, directory);
      } catch (error) {
        this.logger.error(
          `Removing the interrupted clone ${directory.path} failed: ${errorText(error)}`,
        );
      }
      this.sessions.updateDirectory(sessionId, position, {
        state: 'failed',
        additionState: 'failed',
        additionError: message,
        setupStatus: directory.setupStatus === 'none' ? 'none' : 'pending',
      });
      emit(sessionId, {
        type: 'prepare.progress',
        step: 'add',
        state: 'failed',
        target: directory.repositoryName,
        path: directory.path,
        message: `${message}; retry or remove it in the session details.`,
        addition: randomUUID(),
      });
    }
  }

  // -------------------------------------------------------------------------

  private directoryAt(
    session: SessionRecord,
    position: number,
  ): SessionDirectoryRecord {
    const directory = session.directories.find(
      (entry) => entry.position === position,
    );
    if (!directory) {
      throw new ConflictException(
        `The session has no directory at position ${position}`,
      );
    }
    return directory;
  }

  /** Removes an added repository's clone (if any) and empty parents. */
  private async removeAddedClone(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
  ): Promise<void> {
    if (!session.slug || !(await exists(directory.path))) {
      return;
    }
    await this.entries.remove(directory.path, cloneRule(session.slug));
    await this.removeEmptyParents(directory.path);
  }

  private get entries(): WorkspaceEntries {
    this.workspaceEntries ??= new WorkspaceEntries(
      this.config,
      this.git.launcher,
    );
    return this.workspaceEntries;
  }

  private parseRepositories(
    value: unknown,
  ): { repositoryId: string; baseBranch: string | null }[] {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException('repositories must be an array');
    }
    if (value.length > MAX_SESSION_REPOSITORIES) {
      throw new BadRequestException(
        `A session can have at most ${MAX_SESSION_REPOSITORIES} repositories`,
      );
    }
    const seen = new Set<string>();
    return value.map((entry, index) => {
      const item = requireObject(entry, `repositories[${index}]`);
      const repositoryId = item['repositoryId'];
      if (!isUuid(repositoryId)) {
        throw new BadRequestException(
          `repositories[${index}].repositoryId must be a UUID`,
        );
      }
      if (seen.has(repositoryId)) {
        throw new BadRequestException(
          'Each repository can be added to a session only once',
        );
      }
      seen.add(repositoryId);
      const baseBranch =
        optionalString(item, 'baseBranch', { maxLength: 200 })?.trim() || null;
      if (baseBranch && !isValidBranchName(baseBranch)) {
        throw new BadRequestException(
          `repositories[${index}].baseBranch is not a valid branch name`,
        );
      }
      return { repositoryId, baseBranch };
    });
  }

  private parseProject(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    return requireString(requireObject(value, 'newProject'), 'name').trim();
  }

  /** `<sessions>/<slug>/<owner>/<name>`: one directory per session. */
  private clonePath(repository: RepositoryRecord, slug: string): string {
    return join(
      this.config.sessionsDir,
      slug,
      repository.owner,
      repository.name,
    );
  }

  private async uniqueSlug(): Promise<string> {
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = newSlug();
      if (
        !this.sessions.slugExists(slug) &&
        !(await exists(join(this.config.sessionsDir, slug))) &&
        !(await exists(join(this.config.scratchDir, slug)))
      ) {
        return slug;
      }
    }
    throw new ConflictException(
      'Could not find a free session name; try again',
    );
  }

  /** Removes the session's directory `<sessions>/<slug>` once it is empty. */
  private async removeEmptyParents(path: string): Promise<void> {
    for (
      let dir = dirname(path);
      dir.startsWith(`${this.config.sessionsDir}/`);
      dir = dirname(dir)
    ) {
      try {
        await rmdir(dir);
      } catch {
        return;
      }
    }
  }

  private async createScratch(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
    emit: Emit,
  ): Promise<void> {
    emit(progress('scratch', 'started', null, directory.path, null));
    try {
      await mkdir(dirname(directory.path), { recursive: true });
      await mkdir(directory.path);
      await handOverToSession(directory.path, this.git.launcher);
    } catch (error) {
      const message = `Could not create the scratch directory: ${errorText(error)}`;
      this.sessions.updateDirectory(session.id, directory.position, {
        state: 'failed',
      });
      emit(progress('scratch', 'failed', null, directory.path, message));
      throw new Error(message);
    }
    this.sessions.updateDirectory(session.id, directory.position, {
      state: 'ready',
    });
    emit(progress('scratch', 'succeeded', null, directory.path, null));
  }

  /**
   * Updates the mirror (falling back to its last fetched state if the
   * remote cannot be reached), then clones it for the session.
   */
  private async createClone(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
    emit: Emit,
  ): Promise<void> {
    const name = directory.repositoryName;
    const repositoryId = directory.repositoryId as string;
    const branch = directory.branch as string;
    let step: 'fetch' | 'clone' = 'fetch';
    try {
      emit(progress('fetch', 'started', name, null, null));
      const repository = await this.updateMirror(repositoryId, name, emit);

      step = 'clone';
      emit(progress('clone', 'started', name, directory.path, null));
      const baseBranch = directory.baseBranch ?? repository.defaultBranch;
      let baseCommit: string | null = null;
      if (baseBranch) {
        baseCommit = await this.git.branchCommit(
          repository.localPath,
          baseBranch,
        );
        if (!baseCommit && !(await this.git.isEmpty(repository.localPath))) {
          throw new Error(`Branch ${baseBranch} does not exist`);
        }
      } else if (!(await this.git.isEmpty(repository.localPath))) {
        throw new Error('The default branch is unknown; choose a base branch');
      }
      await this.git.createSessionClone({
        mirrorPath: repository.localPath,
        path: directory.path,
        remoteUrl: repository.cloneUrl,
        branch,
        baseCommit,
      });
      // Credentials for origin are the user's own (git configuration,
      // credential helpers, SSH keys), as in a terminal.
      await this.git.configureClone(directory.path, {
        identity: this.settings.gitIdentity(),
      });
      this.sessions.updateDirectory(session.id, directory.position, {
        state: 'ready',
        baseBranch,
        baseCommit,
      });
      emit(
        progress(
          'clone',
          'succeeded',
          name,
          directory.path,
          baseCommit
            ? `${branch} from ${baseBranch} at ${baseCommit.slice(0, 12)}`
            : `${branch} (no commits yet)`,
        ),
      );
    } catch (error) {
      const message = `${step === 'fetch' ? 'Could not update' : 'Could not create the clone of'} ${name}: ${errorText(error)}`;
      this.sessions.updateDirectory(session.id, directory.position, {
        state: 'failed',
      });
      emit(
        progress(
          step,
          'failed',
          name,
          step === 'fetch' ? null : directory.path,
          message,
        ),
      );
      throw new Error(message);
    }
  }

  /**
   * Fetches the mirror. If that fails but a mirror exists, the session
   * starts from its last fetched state with a visible warning.
   */
  private async updateMirror(
    repositoryId: string,
    name: string | null,
    emit: Emit,
  ): Promise<RepositoryRecord> {
    try {
      const repository = await this.repositories.update(repositoryId);
      emit(
        progress(
          'fetch',
          'succeeded',
          name,
          null,
          repository.defaultBranch
            ? `Default branch ${repository.defaultBranch}`
            : 'The repository has no branches yet',
        ),
      );
      return repository;
    } catch (error) {
      const repository = this.repositories.require(repositoryId);
      if (
        !repository.clonedAt ||
        !(await this.git.isBareRepository(repository.localPath))
      ) {
        throw error;
      }
      const age = repository.fetchedAt
        ? `${ageInWords(repository.fetchedAt)} ago`
        : 'at an unknown time';
      emit(
        progress(
          'fetch',
          'failed',
          name,
          null,
          `Could not update ${name}: ${errorText(error)}`,
        ),
      );
      emit({
        type: 'notice',
        level: 'warning',
        text: `${name} could not be fetched; the session starts from the state fetched ${age}.`,
      });
      return repository;
    }
  }

  private async runSetupScripts(
    sessionId: string,
    emit: Emit,
    signal: AbortSignal,
    select: (directory: SessionDirectoryRecord) => boolean,
    selectEnvironment: (status: SetupStatus) => boolean = () => false,
  ): Promise<SetupOutcome> {
    const session = this.sessions.require(sessionId);
    const failed: string[] = [];
    const clones = session.directories.filter(
      (entry) => isClone(entry) && select(entry),
    );
    const environmentSelected = selectEnvironment(
      session.environmentSetupStatus,
    );
    const cloneScripts = clones.some(
      (directory) =>
        !!this.repositories.require(directory.repositoryId as string)
          .setupScript,
    );
    // The environment's variables and files, for every script. A problem
    // with them (e.g. the key changed) fails the environment's setup, not
    // the repositories' scripts, which run without them.
    let environment: LaunchEnvironment | null = null;
    let written: WrittenFiles | null = null;
    let problem: string | null = null;
    if (
      session.environmentId &&
      this.environments &&
      (environmentSelected || cloneScripts)
    ) {
      try {
        environment = this.environments.forLaunch(session.environmentId);
        if (
          environment &&
          this.environmentFiles &&
          (cloneScripts || (environmentSelected && environment.setupScript))
        ) {
          written = await this.environmentFiles.write(
            sessionId,
            environment.files,
          );
        }
      } catch (error) {
        problem = errorText(error);
      }
    }
    const environmentName = `environment ${
      environment?.name ??
      this.environments?.summary(session.environmentId)?.name ??
      ''
    }`.trim();
    const environmentScript =
      environmentSelected && environment?.setupScript
        ? environment.setupScript
        : null;
    if (
      environmentSelected &&
      !environmentScript &&
      !problem &&
      session.environmentSetupStatus !== 'none'
    ) {
      // The script was removed from the environment meanwhile.
      this.sessions.update(sessionId, { environmentSetupStatus: 'none' });
    }
    if (problem && environmentSelected) {
      this.sessions.update(sessionId, { environmentSetupStatus: 'failed' });
      failed.push(environmentName);
    }
    if (problem) {
      emit({
        type: 'setup.result',
        repository: environmentName,
        path: workingDirectoryOf(session),
        state: 'failed',
        exitCode: null,
        signal: null,
        durationMs: null,
        message: `The variables and files of the environment could not be prepared: ${problem}`,
        outputTail: null,
      });
    }
    const environmentEnv = problem
      ? {}
      : { ...(environment?.variables ?? {}), ...(written?.env ?? {}) };
    try {
      for (const directory of clones) {
        const repository = this.repositories.require(
          directory.repositoryId as string,
        );
        const name = directory.repositoryName as string;
        const outcome = await this.runScript({
          name,
          path: directory.path,
          script: repository.setupScript,
          env: {
            ...environmentEnv,
            CRM_SESSION_ID: sessionId,
            CRM_SESSION_SLUG: session.slug ?? '',
            CRM_REPOSITORY: name,
            CRM_CLONE: directory.path,
          },
          emit,
          signal,
          status: (setupStatus) =>
            this.sessions.updateDirectory(sessionId, directory.position, {
              setupStatus,
            }),
        });
        if (outcome === 'failed') {
          failed.push(name);
        }
      }
      if (environmentScript && environment && !problem) {
        const name = environmentName;
        const cwd = workingDirectoryOf(session);
        const outcome = await this.runScript({
          name,
          path: cwd,
          script: environmentScript,
          env: {
            ...environmentEnv,
            CRM_SESSION_ID: sessionId,
            CRM_SESSION_SLUG: session.slug ?? '',
          },
          emit,
          signal,
          status: (environmentSetupStatus) =>
            this.sessions.update(sessionId, { environmentSetupStatus }),
        });
        if (outcome === 'failed') {
          failed.push(name);
        }
      }
    } finally {
      if (written) {
        await this.environmentFiles
          ?.remove(written)
          .catch((error: unknown) =>
            this.logger.warn(
              `Could not remove the environment files ${written.dir}: ${errorText(error)}`,
            ),
          );
      }
    }
    return { failed };
  }

  /**
   * Runs one setup script (of a repository or the environment), with its
   * events and status. `failed`: it failed or timed out (not when the
   * session was ended).
   */
  private async runScript({
    name,
    path,
    script,
    env,
    emit,
    signal,
    status,
  }: {
    name: string;
    path: string;
    script: string | null;
    env: Record<string, string>;
    emit: Emit;
    signal: AbortSignal;
    status: (status: SetupStatus) => void;
  }): Promise<'ok' | 'failed'> {
    const result = (
      state: SetupResultEvent['state'],
      details: Partial<Omit<SetupResultEvent, 'type' | 'seq' | 'at'>> = {},
    ): SessionEventInput => ({
      type: 'setup.result',
      repository: name,
      path,
      state,
      exitCode: null,
      signal: null,
      durationMs: null,
      message: null,
      outputTail: null,
      ...details,
    });
    if (!script) {
      status('none');
      return 'ok';
    }
    if (signal.aborted) {
      status('skipped');
      emit(result('skipped', { message: 'The session was ended' }));
      return 'ok';
    }
    status('running');
    emit(result('started'));
    const outcome = await this.setup.run({
      script,
      cwd: path,
      env,
      timeoutMs: this.config.setupScriptTimeoutMs,
      signal,
      onOutput: (text) =>
        emit({ type: 'setup.output', repository: name, text }),
    });
    status(outcome.state);
    emit(
      result(outcome.state, {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        message: outcome.message,
        outputTail: outcome.outputTail,
      }),
    );
    return outcome.state !== 'succeeded' && !signal.aborted ? 'failed' : 'ok';
  }
}

/** Marks preparation events as belonging to one addition. */
function tagAddition(emit: Emit, addition: string): Emit {
  return (event) =>
    emit(
      event.type === 'prepare.progress' ||
        event.type === 'setup.output' ||
        event.type === 'setup.result'
        ? { ...event, addition }
        : event,
    );
}

function progress(
  step: Extract<SessionEventInput, { type: 'prepare.progress' }>['step'],
  state: 'started' | 'succeeded' | 'failed',
  target: string | null,
  path: string | null,
  message: string | null,
): SessionEventInput {
  return { type: 'prepare.progress', step, state, target, path, message };
}
