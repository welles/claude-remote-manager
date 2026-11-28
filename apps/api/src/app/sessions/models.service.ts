import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ModelListResponse,
  ModelOption,
} from '@claude-remote-manager/shared-types';
import { AgentRunner, type AgentProbe } from '../agent/agent-runner';
import {
  AccountsService,
  defaultAccountKey,
} from '../accounts/accounts.service';

/** How long the list Claude Code reported is used. */
export const MODELS_CACHE_MS = 60 * 60_000;
/** After a failure, Claude Code is asked again after this long at the earliest. */
export const MODELS_RETRY_MS = 60_000;

/** Used when Claude Code cannot be asked: its aliases, which always resolve. */
export const FALLBACK_MODELS: ModelOption[] = [
  {
    value: null,
    label: 'Default',
    description: "Claude Code's default model for the account",
    resolvedModel: null,
  },
  {
    value: 'opus',
    label: 'Opus',
    description: 'Latest Opus model',
    resolvedModel: null,
  },
  {
    value: 'sonnet',
    label: 'Sonnet',
    description: 'Latest Sonnet model',
    resolvedModel: null,
  },
  {
    value: 'haiku',
    label: 'Haiku',
    description: 'Latest Haiku model (fast, cheap)',
    resolvedModel: null,
  },
];

/**
 * The models a session can use, as Claude Code reports them for the
 * logged-in account (asked through a short-lived process without prompt,
 * cached), or a fixed list of aliases if that fails.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private cached: { response: ModelListResponse; until: number } | null = null;
  private loading: Promise<ModelListResponse> | null = null;

  /** Clock; replaced in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly runner: AgentRunner,
    // The models of the default account; without it the main one.
    @Optional() private readonly accounts?: AccountsService,
  ) {
    // Another default account (or login): its own list.
    let key: string | null = null;
    accounts?.changes$.subscribe((list) => {
      const next = defaultAccountKey(list);
      if (key !== null && next !== key) {
        this.cached = null;
      }
      key = next;
    });
  }

  list(): Promise<ModelListResponse> {
    if (this.cached && this.cached.until > this.now()) {
      return Promise.resolve(this.cached.response);
    }
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<ModelListResponse> {
    try {
      const task = (probe: AgentProbe) => probe.supportedModels();
      // The default account's models.
      const models = this.accounts
        ? await this.accounts.withAccount(null, (account) =>
            this.runner.probe(task, account),
          )
        : await this.runner.probe(task);
      if (models.length === 0) {
        throw new Error('Claude Code reported no models');
      }
      const response: ModelListResponse = {
        models,
        source: 'claude-code',
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.cached = { response, until: this.now() + MODELS_CACHE_MS };
      return response;
    } catch (error) {
      this.logger.warn(`Could not read the models: ${String(error)}`);
      const response: ModelListResponse = {
        models: FALLBACK_MODELS,
        source: 'fallback',
        updatedAt: null,
      };
      this.cached = { response, until: this.now() + MODELS_RETRY_MS };
      return response;
    }
  }
}
