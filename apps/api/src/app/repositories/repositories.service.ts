import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateRepositoryRequest,
  RepositoryBranchesResponse,
  RepositoryDto,
  RepositoryListResponse,
  UpdateRepositoryRequest,
  WorktreeDto,
} from '@claude-remote-manager/shared-types';
import { requireObject, requireString } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { InvalidCloneUrlError, parseCloneUrl } from '../git/clone-url';
import { GitService, type GitWorktree } from '../git/git.service';
import {
  RepositoryRepository,
  type RepositoryRecord,
  type WorktreeLink,
} from './repository.repository';

export const MAX_SETUP_SCRIPT_LENGTH = 20_000;

/** Subdirectories of a directory; none if it does not exist. */
async function subdirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `null` for a missing or blank script, otherwise the script. */
function parseSetupScript(body: Record<string, unknown>): string | null {
  const value = body['setupScript'];
  if (value === undefined || value === null) {
    return null;
  }
  const script = requireString(body, 'setupScript', {
    maxLength: MAX_SETUP_SCRIPT_LENGTH,
  });
  return script.trim() ? script.replace(/\r\n/g, '\n') : null;
}

/**
 * Registered repositories: their shared clones, setup scripts and the
 * worktrees sessions have of them.
 */
@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repositories: RepositoryRepository,
    private readonly git: GitService,
  ) {}

  async list(): Promise<RepositoryListResponse> {
    const records = this.repositories.list();
    const links = this.repositories.worktreeLinks(
      records.map((record) => record.id),
    );
    const known = new Set(
      records.map((record) => `${record.owner}/${record.name}`),
    );
    const strayDirectories: string[] = [];
    for (const owner of await subdirectories(this.config.worktreesDir)) {
      for (const name of await subdirectories(
        join(this.config.worktreesDir, owner),
      )) {
        if (!known.has(`${owner}/${name}`)) {
          const dir = join(this.config.worktreesDir, owner, name);
          for (const slug of await subdirectories(dir)) {
            strayDirectories.push(join(dir, slug));
          }
        }
      }
    }
    return {
      repositories: await Promise.all(
        records.map((record) => this.toDto(record, links.get(record.id) ?? [])),
      ),
      strayDirectories,
    };
  }

  async get(id: string): Promise<RepositoryDto> {
    const record = this.require(id);
    return this.toDto(
      record,
      this.repositories.worktreeLinks([id]).get(id) ?? [],
    );
  }

  /** Registers a repository and starts cloning it in the background. */
  async register(request: CreateRepositoryRequest): Promise<RepositoryDto> {
    const body = requireObject(request);
    let parsed;
    try {
      parsed = parseCloneUrl(requireString(body, 'cloneUrl'));
    } catch (error) {
      if (error instanceof InvalidCloneUrlError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const setupScript = parseSetupScript(body);
    const existing = this.repositories.findByName(parsed.owner, parsed.name);
    if (existing) {
      throw new ConflictException(
        `${existing.owner}/${existing.name} is already registered`,
      );
    }
    const record = this.repositories.create({
      id: randomUUID(),
      owner: parsed.owner,
      name: parsed.name,
      cloneUrl: parsed.url,
      localPath: join(this.config.reposDir, parsed.owner, parsed.name),
      setupScript,
    });
    this.updateInBackground(record.id);
    return this.get(record.id);
  }

  async updateSettings(
    id: string,
    request: UpdateRepositoryRequest,
  ): Promise<RepositoryDto> {
    const body = requireObject(request);
    if (!('setupScript' in body)) {
      throw new BadRequestException(
        'setupScript is required (null removes it)',
      );
    }
    this.require(id);
    this.repositories.update(id, { setupScript: parseSetupScript(body) });
    return this.get(id);
  }

  /** Starts a fetch (or the clone, if it is missing) in the background. */
  async refresh(id: string): Promise<RepositoryDto> {
    this.require(id);
    this.updateInBackground(id);
    return this.get(id);
  }

  async branches(id: string): Promise<RepositoryBranchesResponse> {
    const record = this.require(id);
    if (!record.clonedAt) {
      return { defaultBranch: null, branches: [] };
    }
    return {
      defaultBranch: record.defaultBranch,
      branches: await this.git.remoteBranches(record.localPath),
    };
  }

  /**
   * Clones the repository on first use, otherwise fetches it, and records
   * the outcome. Concurrent calls share one fetch. Throws on failure.
   */
  async update(id: string): Promise<RepositoryRecord> {
    const record = this.require(id);
    try {
      const result = await this.git.update(record.localPath, record.cloneUrl);
      const now = new Date();
      return this.repositories.update(id, {
        defaultBranch: result.defaultBranch,
        clonedAt: this.repositories.require(id).clonedAt ?? now,
        fetchedAt: now,
        lastError: null,
      });
    } catch (error) {
      this.repositories.update(id, { lastError: errorText(error) });
      throw error;
    }
  }

  require(id: string): RepositoryRecord {
    const record = this.repositories.get(id);
    if (!record) {
      throw new NotFoundException(`Repository ${id} not found`);
    }
    return record;
  }

  // -------------------------------------------------------------------------

  private updateInBackground(id: string): void {
    this.update(id).catch((error: unknown) =>
      this.logger.warn(`Updating repository ${id} failed: ${errorText(error)}`),
    );
  }

  /**
   * Worktrees of a repository from three sources: what sessions use (the
   * database), what git has registered, and the directories under
   * `WORKTREES_DIR/<owner>/<name>`. Anything without a session is orphaned.
   */
  private async worktrees(
    record: RepositoryRecord,
    links: WorktreeLink[],
  ): Promise<WorktreeDto[]> {
    let registered: GitWorktree[] = [];
    if (record.clonedAt) {
      try {
        registered = await this.git.listWorktrees(record.localPath);
      } catch (error) {
        this.logger.warn(
          `Listing worktrees of ${record.owner}/${record.name} failed: ${errorText(error)}`,
        );
      }
    }
    const dir = join(this.config.worktreesDir, record.owner, record.name);
    const onDisk = new Set(
      (await subdirectories(dir)).map((slug) => join(dir, slug)),
    );
    const byPath = new Map(links.map((link) => [link.path, link]));
    const gitByPath = new Map(registered.map((entry) => [entry.path, entry]));
    const paths = [
      ...new Set([...byPath.keys(), ...gitByPath.keys(), ...onDisk]),
    ].sort();
    return paths.map((path) => {
      const link = byPath.get(path);
      const entry = gitByPath.get(path);
      // Outside the worktrees directory only git knows (worktrees made by
      // hand); locked worktrees are never reported prunable, though.
      const exists = path.startsWith(`${dir}/`)
        ? onDisk.has(path)
        : entry !== undefined && !entry.prunable;
      return {
        path,
        branch: entry?.branch ?? link?.branch ?? null,
        sessionId: link?.sessionId ?? null,
        sessionTitle: link?.sessionTitle ?? null,
        orphaned: !link,
        missing: link !== undefined && !exists,
      };
    });
  }

  private async toDto(
    record: RepositoryRecord,
    links: WorktreeLink[],
  ): Promise<RepositoryDto> {
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    return {
      id: record.id,
      owner: record.owner,
      name: record.name,
      fullName: `${record.owner}/${record.name}`,
      cloneUrl: record.cloneUrl,
      defaultBranch: record.defaultBranch,
      localPath: record.localPath,
      setupScript: record.setupScript,
      clonedAt: iso(record.clonedAt),
      fetchedAt: iso(record.fetchedAt),
      lastError: record.lastError,
      activity: this.git.isUpdating(record.localPath)
        ? record.clonedAt
          ? 'fetching'
          : 'cloning'
        : null,
      worktrees: await this.worktrees(record, links),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
