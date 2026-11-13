import { mkdir, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type {
  CreateSessionRequest,
  SessionEventInput,
  SetupResultEvent,
} from '@claude-remote-manager/shared-types';
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
import { isGitPushCommand } from '../sessions/approval-grants';
import { credentialHelperCommand } from '../git/credential-helper';
import { GitService, isValidBranchName } from '../git/git.service';
import { isGitHubRepository } from '../repositories/repository-credentials';
import { newSlug } from '../git/slug';
import { RepositoriesService } from '../repositories/repositories.service';
import type { RepositoryRecord } from '../repositories/repository.repository';
import {
  SessionRepository,
  type NewSessionDirectory,
  type SessionDirectoryRecord,
  type SessionRecord,
} from '../sessions/session.repository';
import { SettingsService } from '../settings/settings.service';
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
export class SessionWorkspaceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionWorkspaceService.name);
  private subscription: Subscription | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionRepository,
    private readonly repositories: RepositoriesService,
    private readonly git: GitService,
    private readonly setup: SetupScriptRunner,
    private readonly settings: SettingsService,
  ) {}

  /** A changed commit identity applies to all existing session clones. */
  onModuleInit(): void {
    this.subscription = this.settings.changes$.subscribe(
      ({ before, after }) => {
        if (
          before.gitAuthorName !== after.gitAuthorName ||
          before.gitAuthorEmail !== after.gitAuthorEmail
        ) {
          void this.applyIdentity();
        }
      },
    );
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

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
   * exists. Returns the number of clones updated.
   */
  async applyIdentity(): Promise<number> {
    const identity = this.settings.gitIdentity();
    let updated = 0;
    for (const path of this.sessions.readyClonePaths()) {
      try {
        if (await exists(path)) {
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
  async plan(
    request: CreateSessionRequest,
    title: string,
  ): Promise<WorkspacePlan> {
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

    const slug = await this.uniqueSlug(title);
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
    return this.runSetupScripts(sessionId, emit, signal, () => true);
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
        await this.git.removeSessionClone(directory.path);
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

  // -------------------------------------------------------------------------

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

  private async uniqueSlug(title: string): Promise<string> {
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = newSlug(title);
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
      await this.git.configureClone(directory.path, {
        identity: this.settings.gitIdentity(),
        // GitHub clones get their credentials from the session manager,
        // read-only unless the user approved a push.
        credentialHelper: isGitHubRepository(repository)
          ? credentialHelperCommand()
          : null,
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
  ): Promise<SetupOutcome> {
    const session = this.sessions.require(sessionId);
    const failed: string[] = [];
    for (const directory of session.directories.filter(
      (entry) => isClone(entry) && select(entry),
    )) {
      const repository = this.repositories.require(
        directory.repositoryId as string,
      );
      const name = directory.repositoryName as string;
      const result = (
        state: SetupResultEvent['state'],
        details: Partial<Omit<SetupResultEvent, 'type' | 'seq' | 'at'>> = {},
      ): SessionEventInput => ({
        type: 'setup.result',
        repository: name,
        path: directory.path,
        state,
        exitCode: null,
        signal: null,
        durationMs: null,
        message: null,
        outputTail: null,
        ...details,
      });
      if (!repository.setupScript) {
        this.sessions.updateDirectory(sessionId, directory.position, {
          setupStatus: 'none',
        });
        continue;
      }
      if (signal.aborted) {
        this.sessions.updateDirectory(sessionId, directory.position, {
          setupStatus: 'skipped',
        });
        emit(result('skipped', { message: 'The session was ended' }));
        continue;
      }
      this.sessions.updateDirectory(sessionId, directory.position, {
        setupStatus: 'running',
      });
      emit(result('started'));
      const outcome = await this.setup.run({
        script: repository.setupScript,
        cwd: directory.path,
        env: {
          CRM_SESSION_ID: sessionId,
          CRM_SESSION_SLUG: session.slug ?? '',
          CRM_REPOSITORY: name,
          CRM_CLONE: directory.path,
        },
        timeoutMs: this.config.setupScriptTimeoutMs,
        signal,
        onOutput: (text) =>
          emit({ type: 'setup.output', repository: name, text }),
      });
      this.sessions.updateDirectory(sessionId, directory.position, {
        setupStatus: outcome.state,
      });
      if (outcome.state !== 'succeeded' && !signal.aborted) {
        failed.push(name);
      }
      emit(
        result(outcome.state, {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          durationMs: outcome.durationMs,
          message: outcome.message,
          outputTail: outcome.outputTail,
        }),
      );
    }
    return { failed };
  }
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
