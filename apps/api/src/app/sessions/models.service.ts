import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  DEFAULT_ENGINE,
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  type AgentEngineId,
  type ModelListResponse,
  type ModelOption,
} from '@claude-remote-manager/shared-types';
import { AgentEngines } from '../agent/agent-engines';
import { AgentRunner, type AgentProbe } from '../agent/agent-runner';
import {
  AccountsService,
  defaultAccountKey,
} from '../accounts/accounts.service';

/** How long the list an engine reported is used. */
export const MODELS_CACHE_MS = 60 * 60_000;
/** After a failure, the engine is asked again after this long at the earliest. */
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

/** Used when an engine without aliases cannot be asked: its default. */
export function fallbackModels(engine: AgentEngineId): ModelOption[] {
  return engine === 'claude-code'
    ? FALLBACK_MODELS
    : [
        {
          value: null,
          label: 'Default',
          description: `${ENGINE_LABELS[engine]}'s default model for the account`,
          resolvedModel: null,
        },
      ];
}

/**
 * The models a session of an engine can use, as the engine reports them
 * for its provider's default account (asked through a short-lived process
 * without prompt, cached), or a fixed list if that fails.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  /** Per engine, by the default account it was read for. */
  private readonly cached = new Map<
    AgentEngineId,
    { key: string; response: ModelListResponse; until: number }
  >();
  private readonly loading = new Map<
    AgentEngineId,
    { key: string; list: Promise<ModelListResponse> }
  >();

  /** Clock; replaced in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly runner: AgentRunner,
    // The models of the default account; without it the main one.
    @Optional() private readonly accounts?: AccountsService,
    @Optional() private readonly engines?: AgentEngines,
  ) {}

  list(engine: AgentEngineId = DEFAULT_ENGINE): Promise<ModelListResponse> {
    // Another default account (or login) has a list of its own.
    const key = this.accounts
      ? defaultAccountKey(this.accounts.list(), ENGINE_PROVIDERS[engine])
      : '';
    const cached = this.cached.get(engine);
    if (cached && cached.key === key && cached.until > this.now()) {
      return Promise.resolve(cached.response);
    }
    const loading = this.loading.get(engine);
    if (loading?.key === key) {
      return loading.list;
    }
    const list = this.load(engine, key).finally(() => {
      if (this.loading.get(engine)?.list === list) {
        this.loading.delete(engine);
      }
    });
    this.loading.set(engine, { key, list });
    return list;
  }

  private runnerOf(engine: AgentEngineId): AgentRunner {
    return this.engines ? this.engines.runner(engine) : this.runner;
  }

  private async load(
    engine: AgentEngineId,
    key: string,
  ): Promise<ModelListResponse> {
    try {
      const runner = this.runnerOf(engine);
      const task = (probe: AgentProbe) => probe.supportedModels();
      // The default account's models.
      const models = this.accounts
        ? await this.accounts.withAccount(
            null,
            (account) => runner.probe(task, account),
            { provider: ENGINE_PROVIDERS[engine] },
          )
        : await runner.probe(task);
      if (models.length === 0) {
        throw new Error(`${ENGINE_LABELS[engine]} reported no models`);
      }
      const response: ModelListResponse = {
        models,
        source: engine,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.cached.set(engine, {
        key,
        response,
        until: this.now() + MODELS_CACHE_MS,
      });
      return response;
    } catch (error) {
      this.logger.warn(
        `Could not read the models of ${ENGINE_LABELS[engine]}: ${String(error)}`,
      );
      const response: ModelListResponse = {
        models: fallbackModels(engine),
        source: 'fallback',
        updatedAt: null,
      };
      this.cached.set(engine, {
        key,
        response,
        until: this.now() + MODELS_RETRY_MS,
      });
      return response;
    }
  }
}
