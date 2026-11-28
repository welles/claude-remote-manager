import type { AccountProvider } from './accounts';
import {
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  type SessionPermissionMode,
} from './session';

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

/** The permission modes of an engine, in order. */
export const ENGINE_PERMISSION_MODES: Record<
  AgentEngineId,
  readonly SessionPermissionMode[]
> = {
  'claude-code': CLAUDE_CODE_PERMISSION_MODES,
  codex: CODEX_PERMISSION_MODES,
};

/** The mode a session of an engine starts in when none is chosen. */
export const ENGINE_DEFAULT_PERMISSION_MODE: Record<
  AgentEngineId,
  SessionPermissionMode
> = {
  'claude-code': 'default',
  // Asks before commands that are not known to be safe.
  codex: 'untrusted',
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
