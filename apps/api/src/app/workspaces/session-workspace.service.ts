import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type {
  CreateSessionRequest,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import {
  isUuid,
  optionalString,
  requireObject,
  requireString,
} from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { NAME_PATTERN } from '../git/clone-url';
import { GitService, isValidBranchName } from '../git/git.service';
import { newSlug } from '../git/slug';
import { RepositoriesService } from '../repositories/repositories.service';
import type { RepositoryRecord } from '../repositories/repository.repository';
import {
  SessionRepository,
  type NewSessionDirectory,
  type SessionDirectoryRecord,
  type SessionRecord,
} from '../sessions/session.repository';
import { SetupScriptRunner } from './setup-script-runner';

/** Repositories a session may have. */
export const MAX_SESSION_REPOSITORIES = 10;
const SLUG_ATTEMPTS = 10;

/** Directories of a new session, checked and with a unique slug. */
export interface WorkspacePlan {
  slug: string;
  directories: NewSessionDirectory[];
}

/** Preparation failed; the session's worktrees were removed again. */
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

const isWorktree = (directory: SessionDirectoryRecord) =>
  directory.repositoryId !== null && directory.branch !== null;

/**
 * Plans and prepares the directories of sessions: the new project, one
 * worktree per repository on the session branch `claude/<slug>`, and the
 * repositories' setup scripts. If a worktree cannot be created, the ones
 * already created are removed again and the session gets a clear error.
 */
@Injectable()
export class SessionWorkspaceService {
  private readonly logger = new Logger(SessionWorkspaceService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionRepository,
    private readonly repositories: RepositoriesService,
    private readonly git: GitService,
    private readonly setup: SetupScriptRunner,
  ) {}

  /**
   * Validates the workspace part of a session request and picks a slug
   * that no session, worktree directory or branch uses yet. No side
   * effects.
   */
  async plan(
    request: CreateSessionRequest,
    title: string,
  ): Promise<WorkspacePlan> {
    const body = requireObject(request);
    const selections = this.parseRepositories(body['repositories']);
    const project = this.parseProject(body['newProject']);
    if (!project && selections.length === 0) {
      throw new BadRequestException(
        'Choose a main repository or a new project',
      );
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

    let projectPath: string | null = null;
    if (project) {
      projectPath = join(this.config.projectsDir, project);
      if (this.sessions.projectExists(project) || (await exists(projectPath))) {
        throw new ConflictException(
          `A project named ${project} already exists`,
        );
      }
    }

    const slug = await this.uniqueSlug(
      title,
      repositories.map(({ record }) => record),
    );
    const directories: NewSessionDirectory[] = [];
    if (project && projectPath) {
      directories.push({
        path: projectPath,
        repositoryId: null,
        branch: null,
        baseBranch: null,
        state: 'pending',
        setupStatus: 'none',
        newProject: { id: randomUUID(), name: project },
      });
    }
    for (const { record, baseBranch } of repositories) {
      directories.push({
        path: this.worktreePath(record, slug),
        repositoryId: record.id,
        branch: `claude/${slug}`,
        baseBranch,
        state: 'pending',
        setupStatus: record.setupScript ? 'pending' : 'none',
      });
    }
    return { slug, directories };
  }

  /**
   * Creates the session's directories and runs the setup scripts. Throws a
   * {@link PreparationError} after rolling back if a directory could not
   * be created; a failing setup script is only reported. Aborting skips the
   * setup scripts that have not finished.
   */
  async prepare(
    sessionId: string,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.sessions.require(sessionId);
    const failures: string[] = [];
    for (const directory of session.directories) {
      if (directory.projectId && directory.state === 'pending') {
        try {
          await this.createProject(session, directory, emit);
        } catch (error) {
          failures.push(errorText(error));
        }
      }
    }
    if (failures.length === 0) {
      const results = await Promise.allSettled(
        session.directories
          .filter(
            (directory) =>
              isWorktree(directory) && directory.state === 'pending',
          )
          .map((directory) => this.createWorktree(session, directory, emit)),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          failures.push(errorText(result.reason));
        }
      }
    }
    if (failures.length > 0) {
      await this.rollback(sessionId, emit);
      throw new PreparationError(
        `${failures.join('; ')}. The session's other directories were removed again.`,
      );
    }
    await this.runSetupScripts(sessionId, emit, signal);
  }

  /**
   * Removes everything a failed or interrupted preparation created:
   * worktrees with their branches (they have no commits yet) and the new
   * project directory. Directories end as `removed`, or `failed` if they
   * were never created.
   */
  async rollback(
    sessionId: string,
    emit: Emit = () => undefined,
  ): Promise<void> {
    const session = this.sessions.require(sessionId);
    for (const directory of session.directories) {
      if (directory.state !== 'pending' && directory.state !== 'ready') {
        continue;
      }
      const target = directory.repositoryName ?? directory.projectName;
      try {
        if (
          isWorktree(directory) &&
          directory.repositoryId &&
          directory.branch
        ) {
          const repository = this.repositories.require(directory.repositoryId);
          if (await this.git.isBareRepository(repository.localPath)) {
            await this.git.removeWorktree(
              repository.localPath,
              directory.path,
              {
                force: true,
              },
            );
            if (
              await this.git.branchExists(
                repository.localPath,
                directory.branch,
              )
            ) {
              await this.git.deleteBranch(
                repository.localPath,
                directory.branch,
              );
            }
          }
        } else if (directory.projectId && directory.state === 'ready') {
          await rm(directory.path, { recursive: true, force: true });
        }
        this.sessions.updateDirectory(sessionId, directory.position, {
          state: directory.state === 'ready' ? 'removed' : 'failed',
          setupStatus:
            directory.setupStatus === 'pending'
              ? 'skipped'
              : directory.setupStatus,
        });
        if (directory.state === 'ready') {
          emit(
            progress(
              'rollback',
              'succeeded',
              target,
              directory.path,
              'Removed',
            ),
          );
        }
      } catch (error) {
        this.logger.error(
          `Rolling back ${directory.path} of session ${sessionId} failed: ${errorText(error)}`,
        );
        // Not used by the session any more; shown as orphaned if it is
        // still on disk.
        this.sessions.updateDirectory(sessionId, directory.position, {
          state: 'failed',
        });
        emit(
          progress(
            'rollback',
            'failed',
            target,
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
    const name = requireString(
      requireObject(value, 'newProject'),
      'name',
    ).trim();
    if (!NAME_PATTERN.test(name) || name === '..') {
      throw new BadRequestException(
        'newProject.name may contain letters, digits, ".", "_" and "-" (at most 100 characters)',
      );
    }
    return name;
  }

  private worktreePath(repository: RepositoryRecord, slug: string): string {
    return join(
      this.config.worktreesDir,
      repository.owner,
      repository.name,
      slug,
    );
  }

  private async uniqueSlug(
    title: string,
    repositories: RepositoryRecord[],
  ): Promise<string> {
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = newSlug(title);
      if (this.sessions.slugExists(slug)) {
        continue;
      }
      let free = true;
      for (const repository of repositories) {
        if (
          (await exists(this.worktreePath(repository, slug))) ||
          (repository.clonedAt &&
            (await this.git.branchExists(
              repository.localPath,
              `claude/${slug}`,
            )))
        ) {
          free = false;
          break;
        }
      }
      if (free) {
        return slug;
      }
    }
    throw new ConflictException(
      'Could not find a free session name; try again',
    );
  }

  private async createProject(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
    emit: Emit,
  ): Promise<void> {
    const name = directory.projectName;
    emit(progress('project', 'started', name, directory.path, null));
    try {
      await this.git.initProject(directory.path);
    } catch (error) {
      const message = `Could not create the project ${name}: ${errorText(error)}`;
      this.sessions.updateDirectory(session.id, directory.position, {
        state: 'failed',
      });
      emit(progress('project', 'failed', name, directory.path, message));
      throw new Error(message);
    }
    this.sessions.updateDirectory(session.id, directory.position, {
      state: 'ready',
    });
    emit(
      progress(
        'project',
        'succeeded',
        name,
        directory.path,
        'Empty repository on main',
      ),
    );
  }

  private async createWorktree(
    session: SessionRecord,
    directory: SessionDirectoryRecord,
    emit: Emit,
  ): Promise<void> {
    const name = directory.repositoryName;
    const repositoryId = directory.repositoryId as string;
    const branch = directory.branch as string;
    let step: 'fetch' | 'worktree' = 'fetch';
    try {
      emit(progress('fetch', 'started', name, null, null));
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

      step = 'worktree';
      emit(progress('worktree', 'started', name, directory.path, null));
      const baseBranch = directory.baseBranch ?? repository.defaultBranch;
      let baseCommit: string | null = null;
      if (baseBranch) {
        baseCommit = await this.git.remoteBranchCommit(
          repository.localPath,
          baseBranch,
        );
        if (!baseCommit) {
          throw new Error(`Branch ${baseBranch} does not exist`);
        }
      } else if (!(await this.git.isEmpty(repository.localPath))) {
        throw new Error('The default branch is unknown; choose a base branch');
      }
      await this.git.addWorktree({
        repoPath: repository.localPath,
        path: directory.path,
        branch,
        baseCommit,
        lockReason: `claude-remote-manager session ${session.slug ?? session.id}`,
      });
      this.sessions.updateDirectory(session.id, directory.position, {
        state: 'ready',
        baseBranch,
        baseCommit,
      });
      emit(
        progress(
          'worktree',
          'succeeded',
          name,
          directory.path,
          baseCommit
            ? `${branch} from ${baseBranch} at ${baseCommit.slice(0, 12)}`
            : `${branch} (empty repository)`,
        ),
      );
    } catch (error) {
      const message = `${step === 'fetch' ? 'Could not update' : 'Could not create the worktree of'} ${name}: ${errorText(error)}`;
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

  private async runSetupScripts(
    sessionId: string,
    emit: Emit,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.sessions.require(sessionId);
    for (const directory of session.directories.filter(isWorktree)) {
      const repository = this.repositories.require(
        directory.repositoryId as string,
      );
      const name = directory.repositoryName as string;
      const result = (
        state: 'started' | 'succeeded' | 'failed' | 'timed_out' | 'skipped',
        details: Partial<
          Omit<Extract<SessionEventInput, { type: 'setup.result' }>, 'type'>
        > = {},
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
          CRM_WORKTREE: directory.path,
        },
        timeoutMs: this.config.setupScriptTimeoutMs,
        signal,
        onOutput: (text) =>
          emit({ type: 'setup.output', repository: name, text }),
      });
      this.sessions.updateDirectory(sessionId, directory.position, {
        setupStatus: outcome.state,
      });
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
