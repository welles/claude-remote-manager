import type { AccountProvider } from './accounts';
import type { SessionPermissionMode } from './session';

/**
 * The agent engines a session can run with. Each is an adapter of the
 * app's engine-neutral core (see the specification, "Codex als
 * gleichwertige Engine"); none is a special case.
 */
export type AgentEngineId = 'claude-code' | 'codex';

export const AGENT_ENGINES: readonly AgentEngineId[] = ['claude-code', 'codex'];

/** The engine of sessions that do not choose one (and of older ones). */
export const DEFAULT_ENGINE: AgentEngineId = 'claude-code';

/** Which accounts an engine runs with. */
export const ENGINE_PROVIDERS: Record<AgentEngineId, AccountProvider> = {
  'claude-code': 'claude',
  codex: 'chatgpt',
};

export const ENGINE_LABELS: Record<AgentEngineId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** What an engine offers, so that the UI shows what it can, in its terms. */
export interface EngineCapabilities {
  /** The permission modes it offers, in order. */
  permissionModes: SessionPermissionMode[];
  /** A plan mode in which the agent proposes before it changes anything. */
  planMode: boolean;
  /** Slash commands and skills of its own. */
  slashCommands: boolean;
  /** It reports how full its context window is. */
  contextUsage: boolean;
  /** Directories can be added to a running process. */
  addDirectories: boolean;
}

export interface AgentEngineDto {
  id: AgentEngineId;
  label: string;
  provider: AccountProvider;
  capabilities: EngineCapabilities;
}

/** Response of `GET /api/engines`. */
export interface EngineListResponse {
  engines: AgentEngineDto[];
}
