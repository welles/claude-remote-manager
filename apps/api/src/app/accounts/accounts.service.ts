import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { Subject } from 'rxjs';
import {
  MAIN_ACCOUNT_ID,
  MAX_ACCOUNT_NAME_LENGTH,
  type AccountDto,
  type AccountLoginDto,
  type CreateAccountRequest,
  type ReorderAccountsRequest,
  type UpdateAccountRequest,
} from '@claude-remote-manager/shared-types';
import { DATABASE, type AppDatabase } from '../db/database';
import { accounts, sessions } from '../db/schema';
import {
  optionalEnum,
  requireObject,
  requireString,
} from '../common/validation';
import type { AgentAccount } from '../agent/agent-runner';
import { LimitsService } from '../limits/limits.service';
import { ClaudeAccountDirectories } from './claude-account-directories';
import type { ClaudeAuthStatus, ClaudeCli, ClaudeLogin } from './claude-cli';

/** Nest tokens of the helpers (replaced in tests). */
export const CLAUDE_CLI = Symbol('CLAUDE_CLI');
export const CLAUDE_ACCOUNT_DIRECTORIES = Symbol('CLAUDE_ACCOUNT_DIRECTORIES');

type AccountRow = typeof accounts.$inferSelect;

/** How long a finished login stays visible in the UI. */
const LOGIN_RESULT_MS = 10 * 60_000;
const MAX_CODE_LENGTH = 2000;

interface LoginState extends AccountLoginDto {
  process: ClaudeLogin | null;
  /** Clears a finished login from the list. */
  timer: NodeJS.Timeout | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Claude accounts (see `AccountDto`): managing them, logging them in
 * and out from the UI, and which one a session process runs with.
 */
@Injectable()
export class AccountsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountsService.name);
  private readonly logins = new Map<string, LoginState>();
  private readonly changes = new Subject<AccountDto[]>();
  private destroyed = false;
  /** Whether a running process uses an account; set by the sessions. */
  private inUse: (accountId: string) => boolean = () => false;

  /** Emits all accounts after every change (logins, limits, edits). */
  readonly changes$ = this.changes.asObservable();

  constructor(
    @Inject(DATABASE) private readonly db: AppDatabase,
    @Inject(CLAUDE_CLI) private readonly cli: ClaudeCli,
    @Inject(CLAUDE_ACCOUNT_DIRECTORIES)
    private readonly directories: ClaudeAccountDirectories,
    private readonly limits: LimitsService,
  ) {
    limits.setAccounts(
      () => this.rows().map((row) => row.id),
      // Logged-out accounts (also those still logging in) have no limits
      // to read.
      () =>
        this.rows()
          .filter((row) => row.loggedIn === true)
          .map((row) => row.id),
    );
    limits.changes$.subscribe(() => this.publish());
  }

  /** Reads the login state of every account in the background. */
  onModuleInit(): void {
    void this.refreshAll();
  }

  /** Stops logins in progress; later results are dropped. */
  onModuleDestroy(): void {
    this.destroyed = true;
    for (const id of [...this.logins.keys()]) {
      this.cancelLogin(id);
    }
  }

  /** Tells the accounts which ones running session processes use. */
  setUsage(inUse: (accountId: string) => boolean): void {
    this.inUse = inUse;
  }

  list(): AccountDto[] {
    return this.rows().map((row) => this.toDto(row));
  }

  get(id: string): AccountDto {
    return this.toDto(this.requireRow(id));
  }

  /** Whether an account exists. */
  exists(id: string): boolean {
    return this.row(id) !== undefined;
  }

  /**
   * Adds an account and starts its login (the UI shows the URL and asks
   * for the code).
   */
  async create(request: CreateAccountRequest): Promise<AccountDto> {
    const body = requireObject(request);
    optionalEnum(body, 'provider', ['claude'] as const);
    const name = this.validName(body);
    const id = randomUUID();
    await this.directories.prepare(id);
    const position =
      this.rows().reduce((max, row) => Math.max(max, row.position), -1) + 1;
    this.db
      .insert(accounts)
      .values({ id, provider: 'claude', name, position, directory: id })
      .run();
    this.startLogin(id);
    this.publish();
    return this.get(id);
  }

  update(id: string, request: UpdateAccountRequest): AccountDto {
    const body = requireObject(request);
    this.requireRow(id);
    if ('name' in body) {
      const name = this.validName(body);
      this.db.update(accounts).set({ name }).where(eq(accounts.id, id)).run();
    }
    if ('isDefault' in body) {
      if (body['isDefault'] !== true) {
        throw new BadRequestException('isDefault can only be set to true');
      }
      this.db.transaction((tx) => {
        tx.update(accounts).set({ isDefault: false }).run();
        tx.update(accounts)
          .set({ isDefault: true })
          .where(eq(accounts.id, id))
          .run();
      });
    }
    this.publish();
    return this.get(id);
  }

  /** Sets the order (the order of the automatic switch). */
  reorder(request: ReorderAccountsRequest): AccountDto[] {
    const body = requireObject(request);
    const ids = body['ids'];
    const current = this.rows().map((row) => row.id);
    if (
      !Array.isArray(ids) ||
      ids.length !== current.length ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => typeof id === 'string' && current.includes(id))
    ) {
      throw new BadRequestException('ids must list every account once');
    }
    this.db.transaction((tx) => {
      ids.forEach((id: string, position) => {
        tx.update(accounts).set({ position }).where(eq(accounts.id, id)).run();
      });
    });
    this.publish();
    return this.list();
  }

  /**
   * Logs an account out and removes it with its directory. Its sessions
   * continue with the default account. The main account can only be
   * logged out.
   */
  async remove(id: string): Promise<void> {
    const row = this.requireRow(id);
    if (row.directory === null) {
      throw new ConflictException(
        'The main account cannot be removed; log it out instead',
      );
    }
    if (this.inUse(id)) {
      throw new ConflictException(
        'A running session uses this account; switch it to another account or end it first',
      );
    }
    this.cancelLogin(id);
    try {
      await this.cli.logout(this.agentAccountOf(row));
    } catch (error) {
      this.logger.warn(
        `Could not log out account ${id} before removing it: ${errorMessage(error)}`,
      );
    }
    this.db.transaction((tx) => {
      tx.update(sessions)
        .set({ accountId: null })
        .where(eq(sessions.accountId, id))
        .run();
      tx.delete(accounts).where(eq(accounts.id, id)).run();
      if (row.isDefault) {
        const first = tx
          .select()
          .from(accounts)
          .orderBy(asc(accounts.position))
          .get();
        if (first) {
          tx.update(accounts)
            .set({ isDefault: true })
            .where(eq(accounts.id, first.id))
            .run();
        }
      }
    });
    this.limits.forget(id);
    await this.directories.remove(row.directory);
    this.publish();
  }

  /** Starts (or restarts) the login of an account from the UI. */
  startLogin(id: string): AccountDto {
    const row = this.requireRow(id);
    this.cancelLogin(id);
    const process = this.cli.login(this.agentAccountOf(row));
    const state: LoginState = {
      status: 'starting',
      url: null,
      error: null,
      process,
      timer: null,
    };
    this.logins.set(id, state);
    process.url.then(
      (url) => {
        if (this.logins.get(id) === state && state.status === 'starting') {
          state.status = 'waiting';
          state.url = url;
          this.publish();
        }
      },
      () => undefined,
    );
    void process.done.then(async (error) => {
      if (this.logins.get(id) !== state) {
        return;
      }
      state.process = null;
      if (error === null) {
        await this.refresh(id);
        const loggedIn = this.row(id)?.loggedIn === true;
        state.status = loggedIn ? 'done' : 'failed';
        state.error = loggedIn ? null : 'Claude Code is not logged in';
      } else {
        state.status = 'failed';
        state.error = error;
      }
      state.timer = setTimeout(() => {
        if (this.logins.get(id) === state) {
          this.logins.delete(id);
          this.publish();
        }
      }, LOGIN_RESULT_MS);
      state.timer.unref?.();
      this.publish();
    });
    this.publish();
    return this.get(id);
  }

  /** Sends the code from the browser to the running login. */
  submitLoginCode(id: string, body: unknown): AccountDto {
    this.requireRow(id);
    const code = requireString(requireObject(body), 'code', {
      maxLength: MAX_CODE_LENGTH,
      notBlank: true,
    });
    const state = this.logins.get(id);
    if (!state?.process || state.status !== 'waiting') {
      throw new ConflictException('No login waits for a code; start it again');
    }
    state.status = 'verifying';
    state.process.submit(code);
    this.publish();
    return this.get(id);
  }

  cancelLogin(id: string): void {
    const state = this.logins.get(id);
    if (!state) {
      return;
    }
    this.logins.delete(id);
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.process?.cancel();
    this.publish();
  }

  async logout(id: string): Promise<AccountDto> {
    const row = this.requireRow(id);
    this.cancelLogin(id);
    try {
      await this.cli.logout(this.agentAccountOf(row));
    } catch (error) {
      throw new ConflictException(`Logout failed: ${errorMessage(error)}`);
    }
    await this.refresh(id);
    return this.get(id);
  }

  /** Reads the login state of an account again. */
  async refresh(id: string): Promise<void> {
    const row = this.destroyed ? undefined : this.row(id);
    if (!row) {
      return;
    }
    let status: ClaudeAuthStatus;
    try {
      status = await this.cli.status(this.agentAccountOf(row));
    } catch (error) {
      this.logger.warn(
        `Could not read the login of account ${id}: ${errorMessage(error)}`,
      );
      return;
    }
    if (this.destroyed) {
      return;
    }
    this.db
      .update(accounts)
      .set({
        loggedIn: status.loggedIn,
        email: status.email,
        organization: status.organization,
        subscriptionType: status.subscriptionType,
        loginExpiresAt: status.loginExpiresAt,
      })
      .where(eq(accounts.id, id))
      .run();
    this.publish();
  }

  async refreshAll(): Promise<void> {
    for (const row of this.rows()) {
      await this.refresh(row.id);
    }
  }

  /**
   * The account a process of a session runs with (`null`: the default
   * account; one that is gone: the default too), with its directory made
   * ready (shared entries, MCP servers).
   */
  async agentAccount(
    accountId: string | null,
  ): Promise<AgentAccount & { id: string }> {
    const row =
      (accountId ? this.row(accountId) : undefined) ?? this.defaultRow();
    if (row.directory !== null) {
      await this.directories.prepare(row.directory);
    }
    return { id: row.id, ...this.agentAccountOf(row) };
  }

  /**
   * The account `accountId` exactly (no fallback), with its directory made
   * ready; for reading its limits.
   */
  async exactAgentAccount(accountId: string): Promise<AgentAccount> {
    const row = this.requireRow(accountId);
    if (row.directory !== null) {
      await this.directories.prepare(row.directory);
    }
    return this.agentAccountOf(row);
  }

  /** The account a session effectively uses (`null`: the default). */
  effectiveId(accountId: string | null): string {
    return (
      (accountId ? this.row(accountId)?.id : undefined) ?? this.defaultRow().id
    );
  }

  /**
   * The account of a new session: the requested one, else the default
   * unless its limit is exhausted, then the first one in order whose limit
   * is not; when all are, the default.
   */
  forNewSession(requested: string | undefined, now = Date.now()): string {
    if (requested !== undefined) {
      if (!this.exists(requested)) {
        throw new BadRequestException('accountId is not a known account');
      }
      return requested;
    }
    const preferred = this.defaultRow();
    const candidates = [
      preferred,
      ...this.rows().filter((row) => row.id !== preferred.id),
    ].filter((row) => row.loggedIn !== false);
    return (
      candidates.find(
        (row) => this.limits.account(row.id).exhaustedUntil([], now) === null,
      )?.id ?? preferred.id
    );
  }

  private agentAccountOf(row: AccountRow): AgentAccount {
    return {
      configDir: this.directories.path(row.directory),
      main: row.directory === null,
    };
  }

  private validName(body: Record<string, unknown>): string {
    const name = requireString(body, 'name', {
      maxLength: MAX_ACCOUNT_NAME_LENGTH,
      notBlank: true,
    }).trim();
    return name;
  }

  private rows(): AccountRow[] {
    return this.db
      .select()
      .from(accounts)
      .orderBy(asc(accounts.position), asc(accounts.createdAt))
      .all();
  }

  private row(id: string): AccountRow | undefined {
    return this.db.select().from(accounts).where(eq(accounts.id, id)).get();
  }

  private requireRow(id: string): AccountRow {
    const row = this.row(id);
    if (!row) {
      throw new NotFoundException(`Account ${id} not found`);
    }
    return row;
  }

  /** The default account; the main one if none is marked. */
  private defaultRow(): AccountRow {
    const rows = this.rows();
    const found =
      rows.find((row) => row.isDefault) ??
      rows.find((row) => row.id === MAIN_ACCOUNT_ID) ??
      rows[0];
    if (!found) {
      throw new Error('There is no account');
    }
    return found;
  }

  private toDto(row: AccountRow): AccountDto {
    const login = this.logins.get(row.id);
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      position: row.position,
      isDefault: row.isDefault,
      main: row.directory === null,
      loggedIn: row.loggedIn,
      email: row.email,
      organization: row.organization,
      subscriptionType: row.subscriptionType,
      loginExpiresAt: row.loginExpiresAt,
      limits: this.limits.get(row.id),
      login: login
        ? { status: login.status, url: login.url, error: login.error }
        : null,
    };
  }

  private publish(): void {
    if (this.destroyed) {
      return;
    }
    this.changes.next(this.list());
  }
}
