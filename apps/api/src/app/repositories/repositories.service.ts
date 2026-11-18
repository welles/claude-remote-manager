import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  ConnectGitHubRequest,
  CreateRepositoryRequest,
  GitHubRepositoryDto,
  GitHubRepositoryListResponse,
  RepositoryBranchesResponse,
  RepositoryDto,
  RepositoryListResponse,
  SessionCloneDto,
  UpdateRepositoryRequest,
} from '@claude-remote-manager/shared-types';
import {
  optionalString,
  requireObject,
  requireString,
} from '../common/validation';
import { githubTokenAuth } from '../git/git-auth';
import { GitHubApiError } from '../github/github-errors';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import {
  InvalidCloneUrlError,
  NAME_PATTERN,
  parseCloneUrl,
} from '../git/clone-url';
import { GitService } from '../git/git.service';
import {
  GitHubService,
  githubCloneUrl,
  githubFullName,
} from '../github/github.service';
import { SettingsService } from '../settings/settings.service';
import {
  isGitHubRepository,
  RepositoryCredentials,
} from './repository-credentials';
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
    private readonly credentials: RepositoryCredentials,
    private readonly github: GitHubService,
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
    // Clones are known by their session too: a local project that got a
    // GitHub remote keeps its earlier clones under `local/<name>`.
    const linked = new Set([...links.values()].flat().map((link) => link.path));
    const diskPaths = new Set([...onDisk.values()].flat());
    const strayDirectories = [...onDisk.entries()]
      .filter(([key]) => !known.has(key))
      .flatMap(([, paths]) => paths)
      .filter((path) => !linked.has(path));
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
            diskPaths,
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
    if ('githubRepositoryId' in body) {
      return this.registerFromGitHub(body['githubRepositoryId'], setupScript);
    }
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
   * Registers a repository one of the GitHub App's installations can
   * access, and starts cloning its mirror with an installation token.
   * Idempotent: a repository registered before is returned as it is, and
   * one registered by its https URL is linked to GitHub.
   */
  async registerFromGitHub(
    value: unknown,
    setupScript: string | null = null,
  ): Promise<RepositoryDto> {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw new BadRequestException(
        'githubRepositoryId must be a positive integer',
      );
    }
    this.github.requireConfigured();
    const registered = this.repositories.findByGitHubId(value);
    if (registered) {
      return this.get(registered.id);
    }
    const found = await this.github.findRepository(value);
    if (!found) {
      throw new NotFoundException(
        `GitHub repository ${value} is not accessible to the app's installations`,
      );
    }
    for (const [label, part] of [
      ['owner', found.owner],
      ['name', found.name],
    ]) {
      if (!NAME_PATTERN.test(part)) {
        throw new BadRequestException(
          `The repository ${label} "${part}" is not supported`,
        );
      }
    }
    const existing = this.repositories.findByName(found.owner, found.name);
    if (existing) {
      if (
        githubFullName(existing.cloneUrl)?.toLowerCase() !==
        found.fullName.toLowerCase()
      ) {
        throw new ConflictException(
          `${existing.owner}/${existing.name} is already registered with ${existing.cloneUrl ?? 'no remote'}`,
        );
      }
      this.repositories.update(existing.id, {
        githubRepositoryId: found.id,
        githubInstallationId: found.installationId,
      });
      this.updateInBackground(existing.id);
      return this.get(existing.id);
    }
    const record = this.repositories.create({
      id: randomUUID(),
      owner: found.owner,
      name: found.name,
      cloneUrl: githubCloneUrl(found.owner, found.name),
      localPath: join(this.config.reposDir, found.owner, found.name),
      setupScript,
      githubRepositoryId: found.id,
      githubInstallationId: found.installationId,
      defaultBranch: found.defaultBranch,
    });
    this.updateInBackground(record.id);
    return this.get(record.id);
  }

  /** Whether the GitHub App is configured. */
  get githubConfigured(): boolean {
    return this.github.configured;
  }

  /**
   * A repository the GitHub App's installations can access, by `owner/name`
   * (any case). The installations' list is cached for a minute; an unknown
   * name reads it again at most every 15 seconds.
   */
  async findGitHubRepository(fullName: string): Promise<{
    id: number;
    fullName: string;
    defaultBranch: string | null;
  } | null> {
    if (!this.github.configured) {
      return null;
    }
    const wanted = fullName.toLowerCase();
    const find = (listing: Awaited<ReturnType<GitHubService['listing']>>) =>
      listing.repositories.find(
        (repository) => repository.fullName.toLowerCase() === wanted,
      ) ?? null;
    const found = find(await this.github.listing());
    if (found || Date.now() - this.listingRefreshedAt < 15_000) {
      return found;
    }
    this.listingRefreshedAt = Date.now();
    return find(await this.github.listing(true));
  }

  private listingRefreshedAt = 0;

  /** A registered repository by `owner/name` (any case). */
  findByName(fullName: string): RepositoryRecord | undefined {
    const [owner, name, ...rest] = fullName.split('/');
    return owner && name && rest.length === 0
      ? this.repositories.findByName(owner, name)
      : undefined;
  }

  /** A registered repository by its clone URL. */
  findByCloneUrl(url: string): RepositoryRecord | undefined {
    return this.repositories.list().find((record) => record.cloneUrl === url);
  }

  /**
   * Repositories of all installations, filtered by `query` (owner, name or
   * description) and paginated, each with the ID of its registration here.
   */
  async githubRepositories(options: {
    query?: string;
    page?: number;
    perPage?: number;
    refresh?: boolean;
  }): Promise<GitHubRepositoryListResponse> {
    const listing = await this.github.listing(options.refresh ?? false);
    const page = Math.max(1, options.page ?? 1);
    const perPage = Math.min(100, Math.max(1, options.perPage ?? 30));
    const words = (options.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const matches = listing.repositories.filter((repository) => {
      const text =
        `${repository.fullName} ${repository.description ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const records = this.repositories.list();
    const registered = (id: number, fullName: string) =>
      records.find(
        (record) =>
          record.githubRepositoryId === id ||
          githubFullName(record.cloneUrl)?.toLowerCase() ===
            fullName.toLowerCase(),
      )?.id ?? null;
    return {
      repositories: matches.slice((page - 1) * perPage, page * perPage).map(
        (repository): GitHubRepositoryDto => ({
          ...repository,
          registeredRepositoryId: registered(
            repository.id,
            repository.fullName,
          ),
        }),
      ),
      total: matches.length,
      page,
      perPage,
      fetchedAt: listing.fetchedAt.toISOString(),
      errors: [...listing.errors.values()],
    };
  }

  /**
   * Gives a local project a GitHub repository as remote: creates one in an
   * account or organization of an installation (`create`) or uses an
   * existing empty one the app can access (`attach`), pushes the mirror's
   * branches and tags there, and makes the project a normal GitHub
   * repository. No data moves: the mirror stays where it is, existing
   * session clones get the new `origin`.
   */
  async connectGitHub(
    id: string,
    request: ConnectGitHubRequest,
  ): Promise<RepositoryDto> {
    const body = requireObject(request);
    const record = this.require(id);
    if (record.cloneUrl !== null) {
      throw new ConflictException(
        `${record.owner}/${record.name} has a remote already`,
      );
    }
    this.github.requireConfigured();
    const target =
      body['mode'] === 'create'
        ? await this.createGitHubRepository(record, body)
        : body['mode'] === 'attach'
          ? await this.attachableRepository(body['githubRepositoryId'])
          : null;
    if (!target) {
      throw new BadRequestException('mode must be create or attach');
    }
    if (
      !record.clonedAt ||
      !(await this.git.isBareRepository(record.localPath))
    ) {
      await this.update(id);
    }
    const url = githubCloneUrl(target.owner, target.name);
    const pushed = {
      ...record,
      owner: target.owner,
      name: target.name,
      githubRepositoryId: target.id,
      githubInstallationId: target.installationId,
    };
    const workflows = await this.git.changesWorkflows(
      record.localPath,
      '--all',
      null,
      { mirror: true },
    );
    const token = await this.retryNewRepository(() =>
      this.credentials.token(
        pushed,
        {
          contents: 'write',
          ...(workflows ? { workflows: 'write' as const } : {}),
        },
        { fresh: true },
      ),
    );
    try {
      await this.git.attachRemote(
        record.localPath,
        url,
        githubTokenAuth(token.token),
      );
    } catch (error) {
      this.repositories.update(id, { lastError: errorText(error) });
      throw new BadGatewayException(
        `${target.owner}/${target.name} was ${body['mode'] === 'create' ? 'created' : 'chosen'}, but pushing the project there failed: ${errorText(error)}`,
      );
    } finally {
      this.github.tokens.revoke(token.token).catch(() => undefined);
    }
    this.repositories.update(id, {
      owner: target.owner,
      name: target.name,
      cloneUrl: url,
      githubRepositoryId: target.id,
      githubInstallationId: target.installationId,
      lastError: null,
    });
    for (const link of this.repositories.cloneLinks([id]).get(id) ?? []) {
      try {
        await this.git.setOrigin(link.path, url);
      } catch (error) {
        this.logger.warn(
          `Could not point ${link.path} to ${url}: ${errorText(error)}`,
        );
      }
    }
    await this.update(id).catch((error: unknown) =>
      this.logger.warn(`Fetching ${url} failed: ${errorText(error)}`),
    );
    return this.get(id);
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
        {
          identity: this.settings.gitIdentity(),
          // Minted right before git runs, from the current record (the
          // installation may have changed).
          auth: () => this.credentials.readAuth(this.repositories.require(id)),
        },
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

  private async createGitHubRepository(
    record: RepositoryRecord,
    body: Record<string, unknown>,
  ): Promise<{
    id: number;
    owner: string;
    name: string;
    installationId: number;
  }> {
    const owner = requireString(body, 'owner', { maxLength: 100 }).trim();
    const name =
      optionalString(body, 'name', { maxLength: 100 })?.trim() || record.name;
    const description =
      optionalString(body, 'description', { maxLength: 350 })?.trim() || null;
    const isPrivate = body['private'];
    if (isPrivate !== undefined && typeof isPrivate !== 'boolean') {
      throw new BadRequestException('private must be a boolean');
    }
    if (!NAME_PATTERN.test(name)) {
      throw new BadRequestException(
        'The repository name may contain letters, digits, ".", "_" and "-"',
      );
    }
    const installation = (await this.github.installations()).find(
      (entry) => entry.account.toLowerCase() === owner.toLowerCase(),
    );
    if (!installation) {
      throw new BadRequestException(
        `The GitHub App is not installed on ${owner}; install it there first`,
      );
    }
    this.requireFreeName(installation.account, name);
    const created = await this.github.createRepository({
      installation,
      name,
      private: isPrivate !== false,
      description,
    });
    this.logger.log(
      `Created GitHub repository ${created.owner}/${created.name}`,
    );
    return { ...created, installationId: installation.id };
  }

  private async attachableRepository(value: unknown): Promise<{
    id: number;
    owner: string;
    name: string;
    installationId: number;
  }> {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw new BadRequestException(
        'githubRepositoryId must be a positive integer',
      );
    }
    const found = await this.github.findRepository(value);
    if (!found) {
      throw new NotFoundException(
        `GitHub repository ${value} is not accessible to the app's installations`,
      );
    }
    this.requireFreeName(found.owner, found.name);
    if (this.repositories.findByGitHubId(found.id)) {
      throw new ConflictException(`${found.fullName} is already registered`);
    }
    return {
      id: found.id,
      owner: found.owner,
      name: found.name,
      installationId: found.installationId,
    };
  }

  /** A new repository may need a moment before tokens can cover it. */
  private async retryNewRepository<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 3 || !(error instanceof GitHubApiError)) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1)),
        );
      }
    }
  }

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
    present: Set<string>,
  ): Promise<SessionCloneDto[]> {
    const byPath = new Map(links.map((link) => [link.path, link]));
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
    present: Set<string>,
  ): Promise<RepositoryDto> {
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    return {
      id: record.id,
      owner: record.owner,
      name: record.name,
      fullName: `${record.owner}/${record.name}`,
      cloneUrl: record.cloneUrl,
      local: record.cloneUrl === null,
      github: isGitHubRepository(record)
        ? {
            repositoryId: record.githubRepositoryId,
            installationId: record.githubInstallationId,
            htmlUrl: `https://github.com/${record.owner}/${record.name}`,
          }
        : null,
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
      clones: await this.clones(links, onDisk, present),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
