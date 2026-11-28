import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import {
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  DEFAULT_ENGINE,
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  type AccountProvider,
  type AgentEngineDto,
  type AgentEngineId,
  type EngineCapabilities,
  type EngineListResponse,
} from '@claude-remote-manager/shared-types';

/**
 * What each engine offers until the server said so (the list is loading,
 * or could not be loaded); the server's list replaces it.
 */
const KNOWN_CAPABILITIES: Record<AgentEngineId, EngineCapabilities> = {
  'claude-code': {
    permissionModes: [...CLAUDE_CODE_PERMISSION_MODES],
    planMode: true,
    slashCommands: true,
    contextUsage: true,
    addDirectories: true,
  },
  codex: {
    permissionModes: [...CODEX_PERMISSION_MODES],
    planMode: false,
    slashCommands: false,
    contextUsage: true,
    addDirectories: true,
  },
};

/** How the UI names the agent of an engine in sentences ("Claude asks"). */
const AGENT_NAMES: Record<AgentEngineId, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
};

/** The engine of a session; older sessions (and servers) have none. */
export function engineOf(
  session: { engine?: AgentEngineId } | null | undefined,
): AgentEngineId {
  return session?.engine ?? DEFAULT_ENGINE;
}

/** The agent's name in sentences: "Claude" for Claude Code, "Codex". */
export function agentName(engine: AgentEngineId | null | undefined): string {
  return AGENT_NAMES[engine ?? DEFAULT_ENGINE] ?? AGENT_NAMES[DEFAULT_ENGINE];
}

const fallbackEngine = (id: AgentEngineId): AgentEngineDto => ({
  id,
  label: ENGINE_LABELS[id],
  provider: ENGINE_PROVIDERS[id],
  capabilities: KNOWN_CAPABILITIES[id],
});

/**
 * The agent engines of this server (`GET /api/engines`, loaded once):
 * which engines sessions can run with and what each offers. Until the list
 * is known the app behaves as with Claude Code alone.
 */
@Injectable({ providedIn: 'root' })
export class EnginesStore {
  private readonly http = inject(HttpClient);
  private requested = false;
  private readonly loaded = signal<AgentEngineDto[] | null>(null);

  /** The engines of this server; only the default one until loaded. */
  readonly engines = computed(
    () => this.loaded() ?? [fallbackEngine(DEFAULT_ENGINE)],
  );
  /** More than one engine: the UI lets the user choose and names them. */
  readonly several = computed(() => this.engines().length > 1);
  /** The account providers whose engine this server has. */
  readonly providers = computed<AccountProvider[]>(() =>
    this.engines().map((engine) => engine.provider),
  );

  load(): void {
    if (this.requested) {
      return;
    }
    this.requested = true;
    this.http.get<EngineListResponse>('/api/engines').subscribe({
      next: (response) =>
        this.loaded.set(response.engines.length > 0 ? response.engines : null),
      error: () => {
        // Tried again by the next component that needs the list.
        this.requested = false;
      },
    });
  }

  /** An engine of this server, or what is known of it otherwise. */
  engine(id: AgentEngineId | null | undefined): AgentEngineDto {
    const wanted = id ?? DEFAULT_ENGINE;
    return (
      this.engines().find((engine) => engine.id === wanted) ??
      fallbackEngine(wanted in KNOWN_CAPABILITIES ? wanted : DEFAULT_ENGINE)
    );
  }

  /** What an engine offers (Claude Code's for sessions without engine). */
  capabilities(id: AgentEngineId | null | undefined): EngineCapabilities {
    return this.engine(id).capabilities;
  }

  /**
   * Whether to name a session's engine next to its model: when the server
   * has several, or the session's is not the default (e.g. Codex after it
   * was uninstalled).
   */
  showEngine(id: AgentEngineId | null | undefined): boolean {
    return this.several() || (id ?? DEFAULT_ENGINE) !== DEFAULT_ENGINE;
  }
}
