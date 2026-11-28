import { Controller, Get, Injectable } from '@nestjs/common';
import {
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  SESSION_PERMISSION_MODES,
  type AgentEngineDto,
  type AgentEngineId,
  type EngineCapabilities,
  type EngineListResponse,
} from '@claude-remote-manager/shared-types';
import { AgentRunner } from './agent-runner';

/** What Claude Code offers. */
export const CLAUDE_CODE_CAPABILITIES: EngineCapabilities = {
  permissionModes: [...SESSION_PERMISSION_MODES],
  planMode: true,
  slashCommands: true,
  contextUsage: true,
  addDirectories: true,
};

/**
 * The agent engines of this server, each an adapter that starts its
 * processes (see `AgentRunner`). Claude Code is registered like any other
 * engine.
 */
@Injectable()
export class AgentEngines {
  private readonly engines = new Map<
    AgentEngineId,
    { runner: AgentRunner; capabilities: EngineCapabilities }
  >();

  constructor(claudeCode: AgentRunner) {
    this.register('claude-code', claudeCode, CLAUDE_CODE_CAPABILITIES);
  }

  register(
    id: AgentEngineId,
    runner: AgentRunner,
    capabilities: EngineCapabilities,
  ): void {
    this.engines.set(id, { runner, capabilities });
  }

  has(id: string): id is AgentEngineId {
    return this.engines.has(id as AgentEngineId);
  }

  /** The runner of an engine; throws for one this server does not have. */
  runner(id: AgentEngineId): AgentRunner {
    const engine = this.engines.get(id);
    if (!engine) {
      throw new Error(`The engine ${id} is not available on this server`);
    }
    return engine.runner;
  }

  list(): AgentEngineDto[] {
    return [...this.engines].map(([id, engine]) => ({
      id,
      label: ENGINE_LABELS[id],
      provider: ENGINE_PROVIDERS[id],
      capabilities: engine.capabilities,
    }));
  }
}

@Controller('engines')
export class EnginesController {
  constructor(private readonly engines: AgentEngines) {}

  /** The engines sessions can run with, and what each offers. */
  @Get()
  list(): EngineListResponse {
    return { engines: this.engines.list() };
  }
}
