import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  environmentVariableNameProblem,
  ENVIRONMENT_FILE_NAME_PATTERN,
  MAX_ENVIRONMENT_ENTRIES,
  MAX_ENVIRONMENT_FILE_LENGTH,
  MAX_ENVIRONMENT_INSTRUCTIONS_LENGTH,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_ENVIRONMENT_SETUP_SCRIPT_LENGTH,
  MAX_ENVIRONMENT_VALUE_LENGTH,
  SESSION_PERMISSION_MODES,
  type EnvironmentDto,
  type SaveEnvironmentRequest,
  type SessionEnvironmentDto,
  type SessionRepositoryRequest,
} from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import {
  environmentEntries,
  environments,
  repositories,
  sessions,
} from '../db/schema';
import {
  isUuid,
  optionalEnum,
  optionalString,
  requireObject,
  requireString,
} from '../common/validation';
import { isValidBranchName } from '../git/git.service';
import type { MaterializedFile } from './environment-files';
import { SecretCipher } from './secret-cipher';
import {
  maskedStrings,
  NO_MASKING,
  secretMasker,
  type SecretMasker,
} from './secret-masker';

/** Nest token of the {@link SecretCipher}. */
export const SECRET_CIPHER = Symbol('SECRET_CIPHER');

const MODEL_PATTERN = /^[\w.[\]-]{1,100}$/;
const MAX_ENVIRONMENT_REPOSITORIES = 10;

type EnvironmentRow = typeof environments.$inferSelect;
type EntryRow = typeof environmentEntries.$inferSelect;

/** What a process of a session gets from its environment. */
export interface LaunchEnvironment {
  name: string;
  /** Variables (without the paths of the files). */
  variables: Record<string, string>;
  files: MaterializedFile[];
  instructions: string | null;
  setupScript: string | null;
}

/** An entry as parsed from a request, before it is stored. */
interface ParsedEntry {
  id: string | undefined;
  kind: 'variable' | 'file';
  name: string;
  fileName: string | null;
  secret: boolean;
  value: string | undefined;
}

/**
 * Environments: CRUD for the UI (secret values never leave the server),
 * and what sessions get from theirs when a process starts.
 */
@Injectable()
export class EnvironmentsService {
  /** Maskers by environment, valid while `updatedAt` is unchanged. */
  private readonly maskers = new Map<
    string,
    { updatedAt: number; masker: SecretMasker }
  >();

  constructor(
    @Inject(DATABASE) private readonly db: AppDatabase,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
  ) {}

  list(): EnvironmentDto[] {
    const rows = this.db
      .select()
      .from(environments)
      .orderBy(asc(environments.name))
      .all();
    return rows.map((row) => this.toDto(row));
  }

  get(id: string): EnvironmentDto {
    return this.toDto(this.requireRow(id));
  }

  /** Name and ID of an environment, for a session DTO. */
  summary(id: string | null): SessionEnvironmentDto | null {
    if (!id) {
      return null;
    }
    return (
      this.db
        .select({ id: environments.id, name: environments.name })
        .from(environments)
        .where(eq(environments.id, id))
        .get() ?? null
    );
  }

  /** Checks the environment of a new session; 400 if it does not exist. */
  requireForSession(id: unknown): EnvironmentRow | null {
    if (id === undefined || id === null) {
      return null;
    }
    if (!isUuid(id)) {
      throw new BadRequestException('environmentId must be a UUID');
    }
    const row = this.row(id);
    if (!row) {
      throw new BadRequestException(`Environment ${id} not found`);
    }
    return row;
  }

  create(request: SaveEnvironmentRequest): EnvironmentDto {
    const id = randomUUID();
    this.save(id, request, null);
    return this.get(id);
  }

  update(id: string, request: SaveEnvironmentRequest): EnvironmentDto {
    const existing = this.requireRow(id);
    this.save(id, request, existing);
    return this.get(id);
  }

  /** Deletes an environment no session uses that is not archived. */
  remove(id: string): void {
    this.requireRow(id);
    const users = this.sessionsOf(id).filter((session) => !session.archived);
    if (users.length > 0) {
      const names = users
        .map((session) => `"${session.title ?? session.id}"`)
        .join(', ');
      throw new ConflictException(
        `The environment is used by ${users.length === 1 ? 'the session' : 'the sessions'} ${names}; archive ${users.length === 1 ? 'it' : 'them'} first`,
      );
    }
    this.db.delete(environments).where(eq(environments.id, id)).run();
    this.maskers.delete(id);
  }

  /**
   * Everything a process of a session gets from the environment, with the
   * secrets decrypted; `null` without environment.
   */
  forLaunch(environmentId: string | null): LaunchEnvironment | null {
    if (!environmentId) {
      return null;
    }
    const row = this.row(environmentId);
    if (!row) {
      return null;
    }
    const variables: Record<string, string> = {};
    const files: MaterializedFile[] = [];
    for (const entry of this.entries(environmentId)) {
      const value = this.plain(entry);
      if (entry.kind === 'variable') {
        variables[entry.name] = value;
      } else {
        files.push({
          variable: entry.name,
          fileName: entry.fileName as string,
          content: value,
        });
      }
    }
    return {
      name: row.name,
      variables,
      files,
      instructions: row.instructions,
      setupScript: row.setupScript,
    };
  }

  /**
   * Masks the environment's secrets in what the app stores and shows
   * (session events). With the current values: after a change, the next
   * call uses the new ones.
   */
  masker(environmentId: string | null): SecretMasker {
    if (!environmentId) {
      return NO_MASKING;
    }
    const row = this.row(environmentId);
    if (!row) {
      return NO_MASKING;
    }
    const cached = this.maskers.get(environmentId);
    if (cached && cached.updatedAt === row.updatedAt.getTime()) {
      return cached.masker;
    }
    const masker = secretMasker(
      maskedStrings(
        this.entries(environmentId)
          .filter((entry) => entry.secret)
          .map((entry) => ({ kind: entry.kind, value: this.plain(entry) })),
      ),
    );
    this.maskers.set(environmentId, {
      updatedAt: row.updatedAt.getTime(),
      masker,
    });
    return masker;
  }

  private plain(entry: EntryRow): string {
    if (!entry.secret) {
      return entry.value ?? '';
    }
    try {
      return this.cipher.decrypt(entry.encrypted ?? '', entry.id);
    } catch (error) {
      throw new Error(
        `The secret ${entry.name} could not be decrypted (was the key of the environments changed?): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private save(
    id: string,
    request: SaveEnvironmentRequest,
    existing: EnvironmentRow | null,
  ): void {
    const body = requireObject(request);
    const name = requireString(body, 'name', {
      maxLength: MAX_ENVIRONMENT_NAME_LENGTH,
      notBlank: true,
    }).trim();
    const text = (field: string, maxLength: number) => {
      const value = optionalString(body, field, { maxLength });
      return value?.trim() ? value : null;
    };
    const instructions = text(
      'instructions',
      MAX_ENVIRONMENT_INSTRUCTIONS_LENGTH,
    );
    const setupScript = text(
      'setupScript',
      MAX_ENVIRONMENT_SETUP_SCRIPT_LENGTH,
    );
    const model = optionalString(body, 'model')?.trim() || null;
    if (model && !MODEL_PATTERN.test(model)) {
      throw new BadRequestException('model is not a valid model name');
    }
    const permissionMode =
      optionalEnum(body, 'permissionMode', SESSION_PERMISSION_MODES) ?? null;
    const isDefault = body['isDefault'];
    if (isDefault !== undefined && typeof isDefault !== 'boolean') {
      throw new BadRequestException('isDefault must be a boolean');
    }
    const presetRepositories = this.parseRepositories(body['repositories']);
    const entries = [
      ...this.parseEntries(body['variables'], 'variable'),
      ...this.parseEntries(body['files'], 'file'),
    ];
    if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
      throw new BadRequestException(
        `An environment can have at most ${MAX_ENVIRONMENT_ENTRIES} variables and files`,
      );
    }
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.id !== undefined) {
        if (ids.has(entry.id)) {
          throw new BadRequestException(
            `The entry ${entry.id} is given more than once`,
          );
        }
        ids.add(entry.id);
      }
    }
    const names = new Set<string>();
    const fileNames = new Set<string>();
    for (const entry of entries) {
      if (names.has(entry.name)) {
        throw new BadRequestException(`${entry.name} is set more than once`);
      }
      names.add(entry.name);
      if (entry.fileName !== null) {
        if (fileNames.has(entry.fileName)) {
          throw new BadRequestException(
            `The file name ${entry.fileName} is used more than once`,
          );
        }
        fileNames.add(entry.fileName);
      }
    }
    const conflict = this.db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.name, name), ne(environments.id, id)))
      .get();
    if (conflict) {
      throw new ConflictException(`An environment named ${name} exists`);
    }

    const stored = existing ? this.entries(id) : [];
    const rows = entries.map((entry, position) =>
      this.entryRow(id, entry, position, stored),
    );
    const now = new Date();
    this.db.transaction((tx) => {
      if (isDefault) {
        tx.update(environments)
          .set({ isDefault: false })
          .where(ne(environments.id, id))
          .run();
      }
      const columns = {
        name,
        instructions,
        setupScript,
        model,
        permissionMode,
        repositories: presetRepositories,
        isDefault: isDefault ?? existing?.isDefault ?? false,
        updatedAt: now,
      };
      if (existing) {
        tx.update(environments)
          .set(columns)
          .where(eq(environments.id, id))
          .run();
        tx.delete(environmentEntries)
          .where(eq(environmentEntries.environmentId, id))
          .run();
      } else {
        tx.insert(environments)
          .values({ id, ...columns })
          .run();
      }
      for (const row of rows) {
        tx.insert(environmentEntries).values(row).run();
      }
    });
    this.maskers.delete(id);
  }

  /** The row to store for an entry; secrets are encrypted. */
  private entryRow(
    environmentId: string,
    entry: ParsedEntry,
    position: number,
    stored: EntryRow[],
  ): EntryRow {
    const label =
      entry.kind === 'file' ? `The file ${entry.fileName}` : entry.name;
    const previous =
      entry.id !== undefined
        ? stored.find((row) => row.id === entry.id && row.kind === entry.kind)
        : undefined;
    let value = entry.value;
    if (value === undefined) {
      // Only a secret keeps its stored value; a value that was a secret
      // is never revealed by turning the switch off.
      if (!previous) {
        throw new BadRequestException(`${label} needs a value`);
      }
      if (!entry.secret) {
        if (previous.secret) {
          throw new BadRequestException(
            `${label} is no longer a secret: enter its value again`,
          );
        }
        throw new BadRequestException(`${label} needs a value`);
      }
      value = this.plain(previous);
    }
    // New ID for new entries; IDs of other environments are not taken over.
    const id = previous?.id ?? randomUUID();
    return {
      id,
      environmentId,
      position,
      kind: entry.kind,
      name: entry.name,
      fileName: entry.fileName,
      secret: entry.secret,
      value: entry.secret ? null : value,
      encrypted: entry.secret ? this.cipher.encrypt(value, id) : null,
      length: value.length,
    };
  }

  private parseEntries(
    value: unknown,
    kind: 'variable' | 'file',
  ): ParsedEntry[] {
    const field = kind === 'variable' ? 'variables' : 'files';
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array`);
    }
    return value.map((item, index) => {
      const object = requireObject(item, `${field}[${index}]`);
      const id = object['id'];
      if (id !== undefined && id !== null && !isUuid(id)) {
        throw new BadRequestException(`${field}[${index}].id must be a UUID`);
      }
      const secret = object['secret'];
      if (typeof secret !== 'boolean') {
        throw new BadRequestException(
          `${field}[${index}].secret must be a boolean`,
        );
      }
      const name = requireString(
        object,
        kind === 'variable' ? 'name' : 'variable',
        { maxLength: 200 },
      ).trim();
      const problem = environmentVariableNameProblem(name);
      if (problem) {
        throw new BadRequestException(`${name || 'A name'}: ${problem}`);
      }
      let fileName: string | null = null;
      if (kind === 'file') {
        fileName = requireString(object, 'fileName', { maxLength: 100 }).trim();
        if (
          !ENVIRONMENT_FILE_NAME_PATTERN.test(fileName) ||
          fileName === '.' ||
          fileName === '..'
        ) {
          throw new BadRequestException(
            `${fileName || 'A file name'}: use letters, digits, ., _ and - only`,
          );
        }
      }
      const entryValue = optionalString(
        object,
        kind === 'variable' ? 'value' : 'content',
        {
          maxLength:
            kind === 'variable'
              ? MAX_ENVIRONMENT_VALUE_LENGTH
              : MAX_ENVIRONMENT_FILE_LENGTH,
        },
      );
      if (kind === 'variable' && entryValue?.includes('\0')) {
        throw new BadRequestException(`${name} must not contain NUL`);
      }
      return {
        id: (id as string | null | undefined) ?? undefined,
        kind,
        name,
        fileName,
        secret,
        value: entryValue,
      };
    });
  }

  private parseRepositories(value: unknown): SessionRepositoryRequest[] {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException('repositories must be an array');
    }
    if (value.length > MAX_ENVIRONMENT_REPOSITORIES) {
      throw new BadRequestException(
        `An environment can preset at most ${MAX_ENVIRONMENT_REPOSITORIES} repositories`,
      );
    }
    const seen = new Set<string>();
    const result = value.map((entry, index) => {
      const item = requireObject(entry, `repositories[${index}]`);
      const repositoryId = item['repositoryId'];
      if (!isUuid(repositoryId)) {
        throw new BadRequestException(
          `repositories[${index}].repositoryId must be a UUID`,
        );
      }
      if (seen.has(repositoryId)) {
        throw new BadRequestException('Each repository can be preset once');
      }
      seen.add(repositoryId);
      const baseBranch =
        optionalString(item, 'baseBranch', { maxLength: 200 })?.trim() || null;
      if (baseBranch && !isValidBranchName(baseBranch)) {
        throw new BadRequestException(
          `repositories[${index}].baseBranch is not a valid branch name`,
        );
      }
      return { repositoryId, ...(baseBranch ? { baseBranch } : {}) };
    });
    if (result.length > 0) {
      const known = new Set(
        this.db
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            inArray(
              repositories.id,
              result.map((entry) => entry.repositoryId),
            ),
          )
          .all()
          .map((row) => row.id),
      );
      const missing = result.find((entry) => !known.has(entry.repositoryId));
      if (missing) {
        throw new BadRequestException(
          `Repository ${missing.repositoryId} not found`,
        );
      }
    }
    return result;
  }

  private row(id: string): EnvironmentRow | undefined {
    return this.db
      .select()
      .from(environments)
      .where(eq(environments.id, id))
      .get();
  }

  private requireRow(id: string): EnvironmentRow {
    const row = isUuid(id) ? this.row(id) : undefined;
    if (!row) {
      throw new NotFoundException(`Environment ${id} not found`);
    }
    return row;
  }

  private entries(environmentId: string): EntryRow[] {
    return this.db
      .select()
      .from(environmentEntries)
      .where(eq(environmentEntries.environmentId, environmentId))
      .orderBy(asc(environmentEntries.position))
      .all();
  }

  private sessionsOf(id: string): EnvironmentDto['sessions'] {
    return this.db
      .select({
        id: sessions.id,
        title: sessions.title,
        archivedAt: sessions.archivedAt,
      })
      .from(sessions)
      .where(eq(sessions.environmentId, id))
      .orderBy(asc(sessions.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        title: row.title,
        archived: row.archivedAt !== null,
      }));
  }

  private toDto(row: EnvironmentRow): EnvironmentDto {
    const entries = this.entries(row.id);
    return {
      id: row.id,
      name: row.name,
      instructions: row.instructions,
      setupScript: row.setupScript,
      model: row.model,
      permissionMode: row.permissionMode,
      repositories: row.repositories,
      isDefault: row.isDefault,
      variables: entries
        .filter((entry) => entry.kind === 'variable')
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          secret: entry.secret,
          value: entry.secret ? null : (entry.value ?? ''),
          length: entry.length,
        })),
      files: entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => ({
          id: entry.id,
          variable: entry.name,
          fileName: entry.fileName as string,
          secret: entry.secret,
          content: entry.secret ? null : (entry.value ?? ''),
          length: entry.length,
        })),
      sessions: this.sessionsOf(row.id),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
