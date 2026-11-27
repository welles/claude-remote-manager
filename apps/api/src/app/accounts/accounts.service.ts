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

/**
 * How old the login states may get: read again when someone lists the
 * accounts after this, and in the background every
 * {@link LOGIN_REFRESH_INTERVAL_MS} (logins from a terminal, expired ones).
 */
export const LOGIN_STALE_MS = 5 * 60_000;
export const LOGIN_REFRESH_INTERVAL_MS = 15 * 60_000;

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
  private refreshedAt = 0;
  private refreshing: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** Whether a running process uses an account; set by the sessions. */
  private inUse: (accountId: string) => boolean = () => false;
  /** Accounts being removed: no process starts with them any more. */
  /** Short-lived processes (reviews, probes) per account that run now. */
  private readonly leases = new Map<string, number>();
  private readonly removing = new Set<string>();

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
      // Logged-out accounts have no limits to read.
      () =>
        this.rows()
          // Unknown (`null`) counts: a failed check must not stop them.
          .filter((row) => row.loggedIn !== false)
          .map((row) => row.id),
    );
    limits.changes$.subscribe(() => this.publish());
  }

  /** Reads the login state of every account in the background. */
  onModuleInit(): void {
    void this.refreshAll();
    this.refreshTimer = setInterval(
      () => void this.refreshAll(),
      LOGIN_REFRESH_INTERVAL_MS,
    );
    this.refreshTimer.unref?.();
  }

  /** Reads the login states again in the background if they are old. */
  refreshIfStale(now = Date.now()): void {
    if (now - this.refreshedAt >= LOGIN_STALE_MS) {
      void this.refreshAll();
    }
  }

  /** Stops logins in progress; later results are dropped. */
  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
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

  /** Whether an account exists and is not being removed. */
  isUsable(id: string): boolean {
    return !this.removing.has(id) && this.exists(id);
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
    this.requireUsable(id);
    // Both checked before anything is written.
    const name = 'name' in body ? this.validName(body) : undefined;
    if ('isDefault' in body && body['isDefault'] !== true) {
      throw new BadRequestException('isDefault can only be set to true');
    }
    if (name !== undefined) {
      this.db.update(accounts).set({ name }).where(eq(accounts.id, id)).run();
    }
    if ('isDefault' in body) {
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
    const busy = () =>
      new ConflictException(
        'A running session uses this account; switch it to another account or end it first',
      );
    if (this.used(id) || this.removing.has(id)) {
      throw busy();
    }
    // From now on no process starts with it (sessions take the default).
    this.removing.add(id);
    let loggedOut = false;
    let removed = false;
    try {
      this.cancelLogin(id);
      try {
        await this.cli.logout(this.agentAccountOf(row));
        loggedOut = true;
      } catch (error) {
        this.logger.warn(
          `Could not log out account ${id} before removing it: ${errorMessage(error)}`,
        );
      }
      if (this.used(id)) {
        // Started before the removal began.
        throw busy();
      }
      // The directory first: if that fails, the account stays (retry).
      await this.directories.remove(row.directory);
      // A login started meanwhile goes too.
      this.cancelLogin(id);
      this.deleteRow(row);
      this.limits.forget(id);
      removed = true;
    } finally {
      this.removing.delete(id);
      if (loggedOut && !removed) {
        // Logged out although it stays: show that.
        await this.refresh(id);
      }
      this.publish();
    }
  }

  private deleteRow(row: AccountRow): void {
    const id = row.id;
    this.db.transaction((tx) => {
      tx.update(sessions)
        .set({ accountId: null })
        .where(eq(sessions.accountId, id))
        .run();
      tx.delete(accounts).where(eq(accounts.id, id)).run();
      // Whatever is marked now (not the row read before the awaits).
      const hasDefault = tx
        .select()
        .from(accounts)
        .where(eq(accounts.isDefault, true))
        .get();
      if (!hasDefault) {
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
  }

  /** Starts (or restarts) the login of an account from the UI. */
  startLogin(id: string): AccountDto {
    const row = this.requireUsable(id);
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
        const read = await this.refresh(id);
        if (this.logins.get(id) !== state) {
          return;
        }
        // Claude Code said it worked; only a status that says otherwise
        // counts against it (an unreadable one is checked again later).
        const loggedIn = !read || this.row(id)?.loggedIn === true;
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
    this.requireUsable(id);
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
    const row = this.requireUsable(id);
    this.cancelLogin(id);
    try {
      await this.cli.logout(this.agentAccountOf(row));
    } catch (error) {
      throw new ConflictException(`Logout failed: ${errorMessage(error)}`);
    }
    await this.refresh(id);
    return this.get(id);
  }

  /**
   * Reads the login state of an account again. Resolves with whether it
   * could be read (and was stored).
   */
  async refresh(id: string): Promise<boolean> {
    const row =
      this.destroyed || this.removing.has(id) ? undefined : this.row(id);
    if (!row) {
      return false;
    }
    let status: ClaudeAuthStatus;
    try {
      status = await this.cli.status(this.agentAccountOf(row));
    } catch (error) {
      this.logger.warn(
        `Could not read the login of account ${id}: ${errorMessage(error)}`,
      );
      return false;
    }
    if (this.destroyed) {
      return false;
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
    return true;
  }

  /** Reads every account's login state; shares a read in flight. */
  refreshAll(): Promise<void> {
    this.refreshedAt = Date.now();
    this.refreshing ??= (async () => {
      try {
        for (const row of this.destroyed ? [] : this.rows()) {
          await this.refresh(row.id);
        }
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /**
   * The account a process of a session runs with (`null`: the default
   * account; one that is gone: the default too), with its directory made
   * ready (shared entries, MCP servers).
   */
  async agentAccount(
    accountId: string | null,
  ): Promise<AgentAccount & { id: string }> {
    const row = this.pick(accountId);
    if (row.directory !== null) {
      await this.directories.prepare(row.directory);
    }
    return { id: row.id, ...this.agentAccountOf(row) };
  }

  /**
   * Runs a short-lived process (review, probe) with an account (see
   * {@link agentAccount}; `exact`: that account or a failure); the account
   * counts as in use meanwhile, so it cannot be removed under it.
   */
  async withAccount<T>(
    accountId: string | null,
    task: (account: AgentAccount & { id: string }) => Promise<T>,
    { exact = false }: { exact?: boolean } = {},
  ): Promise<T> {
    // Chosen and counted at once, before the directory is prepared, so a
    // removal cannot slip in between.
    const row = exact ? this.pickExact(accountId ?? '') : this.pick(accountId);
    this.leases.set(row.id, (this.leases.get(row.id) ?? 0) + 1);
    try {
      if (row.directory !== null) {
        await this.directories.prepare(row.directory);
      }
      return await task({ id: row.id, ...this.agentAccountOf(row) });
    } finally {
      const left = (this.leases.get(row.id) ?? 1) - 1;
      if (left > 0) {
        this.leases.set(row.id, left);
      } else {
        this.leases.delete(row.id);
      }
    }
  }

  /**
   * The ID of the account a process started now uses (see
   * {@link agentAccount}), without preparing anything.
   */
  pickId(accountId: string | null): string {
    return this.pick(accountId).id;
  }

  /** The account itself, else (unknown or being removed) the default. */
  private pick(accountId: string | null): AccountRow {
    return (
      (accountId && !this.removing.has(accountId)
        ? this.row(accountId)
        : undefined) ?? this.defaultRow()
    );
  }

  private pickExact(accountId: string): AccountRow {
    if (this.removing.has(accountId)) {
      throw new ConflictException(`Account ${accountId} is being removed`);
    }
    return this.requireRow(accountId);
  }

  private used(id: string): boolean {
    return this.inUse(id) || (this.leases.get(id) ?? 0) > 0;
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

  /**
   * The account to switch to when `current`'s limit ended a turn: the next
   * one in order after it (wrapping around) that is logged in and whose
   * limits are not known to be exhausted; `null` if there is none.
   */
  nextAvailable(current: string, now = Date.now()): string | null {
    const rows = this.switchable();
    const index = rows.findIndex((row) => row.id === current);
    const ordered =
      index < 0 ? rows : [...rows.slice(index + 1), ...rows.slice(0, index)];
    return (
      ordered.find(
        (row) =>
          row.id !== current &&
          this.limits.account(row.id).exhaustedUntil([], now) === null,
      )?.id ?? null
    );
  }

  /**
   * When every account is exhausted: the one whose limits reset first,
   * with that time; `null` when no reset is known.
   */
  earliestReset(now = Date.now()): { id: string; at: Date } | null {
    let best: { id: string; at: Date } | null = null;
    for (const row of this.switchable()) {
      const at = this.limits.account(row.id).exhaustedUntil([], now);
      if (at && (!best || at < best.at)) {
        best = { id: row.id, at };
      }
    }
    return best;
  }

  /** Accounts a session can switch to: logged in (or unknown), not removed. */
  private switchable(): AccountRow[] {
    return this.rows().filter(
      (row) => row.loggedIn !== false && !this.removing.has(row.id),
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

  /** An account that is not being removed (else 409). */
  private requireUsable(id: string): AccountRow {
    const row = this.requireRow(id);
    if (this.removing.has(id)) {
      throw new ConflictException(`Account ${id} is being removed`);
    }
    return row;
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
    // Not one being removed (the main account never is).
    const rows = this.rows().filter((row) => !this.removing.has(row.id));
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
