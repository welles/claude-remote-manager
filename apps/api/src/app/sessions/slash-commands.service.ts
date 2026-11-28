import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  SlashCommandOption,
  SlashCommandsResponse,
} from '@claude-remote-manager/shared-types';
import { AgentRunner, type AgentProbe } from '../agent/agent-runner';
import {
  AccountsService,
  defaultAccountKey,
} from '../accounts/accounts.service';

/** How long the user's commands (asked through a probe) are used. */
export const USER_COMMANDS_CACHE_MS = 10 * 60_000;
/** After a failed probe, Claude Code is asked again after this long at the earliest. */
export const USER_COMMANDS_RETRY_MS = 60_000;

/** How long a probe may take to list the commands. */
export const PROBE_TIMEOUT_MS = 20_000;

/**
 * Commands bound to a terminal, hidden from the list. Claude Code names
 * them in its `init` message (`terminal_slash_commands`, added as they
 * come); these are the ones Claude Code 2.1.322 names, for lists asked
 * before any session sent its `init`.
 */
const TERMINAL_COMMANDS = ['doctor', 'color', 'focus', 'reload-plugins'];

/**
 * One row per name: Claude Code's own row where it marks one (that is what
 * `/name` runs), else the first.
 */
export function uniqueCommands(
  commands: readonly SlashCommandOption[],
): SlashCommandOption[] {
  const byName = new Map<string, SlashCommandOption>();
  for (const command of commands) {
    const known = byName.get(command.name);
    if (!known || (command.builtin && !known.builtin)) {
      byName.set(command.name, command);
    }
  }
  return [...byName.values()];
}

/**
 * The slash commands and skills for `/` autocomplete. A session's list is
 * what its Claude Code reported last (`supportedCommands` after `init`,
 * replaced by `commands_changed`; kept in memory after the process ends,
 * until the session is removed or the API restarts). Before that, the
 * user's commands and Claude Code's own,
 * asked through a short-lived process without prompt (cached). Commands
 * bound to a terminal are left out.
 */
@Injectable()
export class SlashCommandsService {
  private readonly logger = new Logger(SlashCommandsService.name);
  private readonly sessions = new Map<string, SlashCommandOption[]>();
  private readonly terminal = new Set(TERMINAL_COMMANDS);
  private user: { commands: SlashCommandOption[]; until: number } | null = null;
  private loading: Promise<SlashCommandOption[]> | null = null;

  /** Clock; replaced in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly runner: AgentRunner,
    // The commands of the default account; without it the main one.
    @Optional() private readonly accounts?: AccountsService,
  ) {
    // Another default account (or login): its own list.
    let key: string | null = null;
    accounts?.changes$.subscribe((list) => {
      const next = defaultAccountKey(list);
      if (key !== null && next !== key) {
        this.user = null;
      }
      key = next;
    });
  }

  async forSession(sessionId: string): Promise<SlashCommandsResponse> {
    const reported = this.sessions.get(sessionId);
    if (reported) {
      return { commands: this.visible(reported), source: 'session' };
    }
    return {
      commands: this.visible(await this.userCommands()),
      source: 'user',
    };
  }

  /** What a session's Claude Code reported (a full list). */
  remember(sessionId: string, commands: readonly SlashCommandOption[]): void {
    this.sessions.set(sessionId, uniqueCommands([...commands]));
  }

  /** Commands Claude Code names as bound to a terminal (`init`). */
  terminalCommands(names: readonly string[]): void {
    for (const name of names) {
      this.terminal.add(name);
    }
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private visible(commands: SlashCommandOption[]): SlashCommandOption[] {
    return commands.filter((command) => !this.terminal.has(command.name));
  }

  private userCommands(): Promise<SlashCommandOption[]> {
    if (this.user && this.user.until > this.now()) {
      return Promise.resolve(this.user.commands);
    }
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** The commands of the default account's Claude Code. */
  private probeCommands(): Promise<SlashCommandOption[]> {
    const task = (probe: AgentProbe) =>
      withTimeout(probe.supportedCommands(), PROBE_TIMEOUT_MS);
    return this.accounts
      ? this.accounts.withAccount(null, (account) =>
          this.runner.probe(task, account),
        )
      : this.runner.probe(task);
  }

  private async load(): Promise<SlashCommandOption[]> {
    try {
      const commands = uniqueCommands(await this.probeCommands());
      this.user = { commands, until: this.now() + USER_COMMANDS_CACHE_MS };
      return commands;
    } catch (error) {
      this.logger.warn(`Listing the slash commands failed: ${String(error)}`);
      const commands = this.user?.commands ?? [];
      this.user = { commands, until: this.now() + USER_COMMANDS_RETRY_MS };
      return commands;
    }
  }
}

/** Rejects when `promise` takes longer than `ms` (the probe then closes). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${ms / 1000} s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
