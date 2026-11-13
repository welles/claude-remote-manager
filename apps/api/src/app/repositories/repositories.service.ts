import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  CreateRepositoryRequest,
  RepositoryBranchesResponse,
  RepositoryDto,
  RepositoryListResponse,
  SessionCloneDto,
  UpdateRepositoryRequest,
} from '@claude-remote-manager/shared-types';
import { requireObject, requireString } from '../common/validation';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  InvalidCloneUrlError,
  NAME_PATTERN,
  parseCloneUrl,
} from '../git/clone-url';
import { GitService } from '../git/git.service';
import { SettingsService } from '../settings/settings.service';
import {
  RepositoryRepository,
  type CloneLink,
  type RepositoryRecord,
} from './repository.repository';

export const MAX_SETUP_SCRIPT_LENGTH = 20_000;

/** Owner of local projects (repositories without remote). */
export const LOCAL_OWNER = 'local';

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
 * Warning if the directories are on different filesystems: session clones
 * then copy the mirrors' objects instead of hardlinking them.
 */
export function filesystemWarning(
  devices: Record<string, number>,
): string | null {
  const distinct = new Set(Object.values(devices));
  if (distinct.size <= 1) {
    return null;
  }
  return (
    `${Object.keys(devices).join(', ')} are on different filesystems; ` +
    'session clones will copy repository objects instead of hardlinking ' +
    'them (correct, but slow and large). Put them on one volume.'
  );
}

/**
 * Registered repositories and local projects: their mirrors, setup scripts
 * and the session clones made from them.
 */
@Injectable()
export class RepositoriesService implements OnModuleInit {
  private readonly logger = new Logger(RepositoriesService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repositories: RepositoryRepository,
    private readonly git: GitService,
    private readonly settings: SettingsService,
  ) {}

  /** Creates the workspace directories and checks they share a filesystem. */
  async onModuleInit(): Promise<void> {
    const { reposDir, sessionsDir, scratchDir } = this.config;
    const devices: Record<string, number> = {};
    for (const dir of [reposDir, sessionsDir, scratchDir]) {
      await mkdir(dir, { recursive: true });
      devices[dir] = (await stat(dir)).dev;
    }
    const warning = filesystemWarning(devices);
    if (warning) {
      this.logger.warn(warning);
    }
  }

  async list(): Promise<RepositoryListResponse> {
    const records = this.repositories.list();
    const links = this.repositories.cloneLinks(
      records.map((record) => record.id),
    );
    // Session clones on disk: <sessionsDir>/<slug>/<owner>/<name>.
    const onDisk = new Map<string, string[]>();
    for (const slug of await subdirectories(this.config.sessionsDir)) {
      const sessionDir = join(this.config.sessionsDir, slug);
      for (const owner of await subdirectories(sessionDir)) {
        for (const name of await subdirectories(join(sessionDir, owner))) {
          const key = `${owner}/${name}`;
          onDisk.set(key, [
            ...(onDisk.get(key) ?? []),
            join(sessionDir, owner, name),
          ]);
        }
      }
    }
    const known = new Set(
      records.map((record) => `${record.owner}/${record.name}`),
    );
    const strayDirectories = [...onDisk.entries()]
      .filter(([key]) => !known.has(key))
      .flatMap(([, paths]) => paths);
    const scratch = this.repositories.activeScratchPaths();
    for (const slug of await subdirectories(this.config.scratchDir)) {
      const path = join(this.config.scratchDir, slug);
      if (!scratch.has(path)) {
        strayDirectories.push(path);
      }
    }
    return {
      repositories: await Promise.all(
        records.map((record) =>
          this.toDto(
            record,
            links.get(record.id) ?? [],
            onDisk.get(`${record.owner}/${record.name}`) ?? [],
          ),
        ),
      ),
      strayDirectories: strayDirectories.sort(),
    };
  }

  async get(id: string): Promise<RepositoryDto> {
    const list = await this.list();
    const found = list.repositories.find((repository) => repository.id === id);
    if (!found) {
      throw new NotFoundException(`Repository ${id} not found`);
    }
    return found;
  }

  /**
   * Registers a repository by clone URL and starts cloning its mirror, or
   * creates a local project; both in the background.
   */
  async register(request: CreateRepositoryRequest): Promise<RepositoryDto> {
    const body = requireObject(request);
    const setupScript = parseSetupScript(body);
    if ('projectName' in body) {
      const record = this.createProject(
        requireString(body, 'projectName'),
        setupScript,
      );
      this.updateInBackground(record.id);
      return this.get(record.id);
    }
    let parsed;
    try {
      parsed = parseCloneUrl(requireString(body, 'cloneUrl'));
    } catch (error) {
      if (error instanceof InvalidCloneUrlError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    this.requireFreeName(parsed.owner, parsed.name);
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

  /**
   * Registers a local project `local/<name>` without remote. Its mirror is
   * created on first use, with an empty initial commit on `main` by the
   * configured commit identity (required).
   */
  createProject(
    name: string,
    setupScript: string | null = null,
  ): RepositoryRecord {
    const trimmed = name.trim();
    this.settings.requireGitIdentity();
    if (!NAME_PATTERN.test(trimmed)) {
      throw new BadRequestException(
        'The project name may contain letters, digits, ".", "_" and "-" (at most 100 characters)',
      );
    }
    this.requireFreeName(LOCAL_OWNER, trimmed);
    return this.repositories.create({
      id: randomUUID(),
      owner: LOCAL_OWNER,
      name: trimmed,
      cloneUrl: null,
      localPath: join(this.config.reposDir, LOCAL_OWNER, trimmed),
      setupScript,
    });
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
      return { defaultBranch: record.defaultBranch, branches: [] };
    }
    return {
      defaultBranch: record.defaultBranch,
      branches: await this.git.branches(record.localPath),
    };
  }

  /**
   * Creates the mirror on first use, otherwise fetches it, and records the
   * outcome. Concurrent calls share one fetch. Throws on failure.
   */
  async update(id: string): Promise<RepositoryRecord> {
    const record = this.require(id);
    try {
      const result = await this.git.updateMirror(
        record.localPath,
        record.cloneUrl,
        { identity: this.settings.gitIdentity() },
      );
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

  private requireFreeName(owner: string, name: string): void {
    const existing = this.repositories.findByName(owner, name);
    if (existing) {
      throw new ConflictException(
        `${existing.owner}/${existing.name} is already registered`,
      );
    }
  }

  private updateInBackground(id: string): void {
    this.update(id).catch((error: unknown) =>
      this.logger.warn(`Updating repository ${id} failed: ${errorText(error)}`),
    );
  }

  /**
   * Session clones of a repository from the database and from disk.
   * Anything without a session is orphaned; a clone a session expects but
   * that is gone is missing.
   */
  private async clones(
    links: CloneLink[],
    onDisk: string[],
  ): Promise<SessionCloneDto[]> {
    const byPath = new Map(links.map((link) => [link.path, link]));
    const present = new Set(onDisk);
    const paths = [...new Set([...byPath.keys(), ...onDisk])].sort();
    return Promise.all(
      paths.map(async (path) => {
        const link = byPath.get(path);
        return {
          path,
          branch:
            link?.branch ??
            (present.has(path) ? await this.git.currentBranch(path) : null),
          sessionId: link?.sessionId ?? null,
          sessionTitle: link?.sessionTitle ?? null,
          orphaned: !link,
          missing: link !== undefined && !present.has(path),
        };
      }),
    );
  }

  private async toDto(
    record: RepositoryRecord,
    links: CloneLink[],
    onDisk: string[],
  ): Promise<RepositoryDto> {
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    return {
      id: record.id,
      owner: record.owner,
      name: record.name,
      fullName: `${record.owner}/${record.name}`,
      cloneUrl: record.cloneUrl,
      local: record.cloneUrl === null,
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
      clones: await this.clones(links, onDisk),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
