import {
  ConflictException,
  Controller,
  Get,
  Injectable,
} from '@nestjs/common';
import {
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  type AgentEngineDto,
  type AgentEngineId,
  type EngineCapabilities,
  type EngineListResponse,
} from '@claude-remote-manager/shared-types';
import { AgentRunner } from './agent-runner';
import { TranscriptReader } from './transcript-reader';

/** One engine: how its processes start and its history is read. */
export interface AgentEngine {
  runner: AgentRunner;
  transcripts: TranscriptReader;
  capabilities: EngineCapabilities;
}

/** What Codex offers (its own approval policies, no plan mode). */
export const CODEX_CAPABILITIES: EngineCapabilities = {
  permissionModes: [...CODEX_PERMISSION_MODES],
  planMode: false,
  slashCommands: false,
  contextUsage: true,
  addDirectories: true,
};

/** What Claude Code offers. */
export const CLAUDE_CODE_CAPABILITIES: EngineCapabilities = {
  permissionModes: [...CLAUDE_CODE_PERMISSION_MODES],
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
  private readonly engines = new Map<AgentEngineId, AgentEngine>();

  constructor(claudeCode: AgentRunner, claudeTranscripts: TranscriptReader) {
    this.register('claude-code', {
      runner: claudeCode,
      transcripts: claudeTranscripts,
      capabilities: CLAUDE_CODE_CAPABILITIES,
    });
  }

  register(id: AgentEngineId, engine: AgentEngine): void {
    this.engines.set(id, engine);
  }

  has(id: string): id is AgentEngineId {
    return this.engines.has(id as AgentEngineId);
  }

  /** An engine; 409 for one this server does not have. */
  get(id: AgentEngineId): AgentEngine {
    const engine = this.engines.get(id);
    if (!engine) {
      throw new ConflictException(
        `The engine ${ENGINE_LABELS[id] ?? id} is not available on this server`,
      );
    }
    return engine;
  }

  runner(id: AgentEngineId): AgentRunner {
    return this.get(id).runner;
  }

  transcripts(id: AgentEngineId): TranscriptReader {
    return this.get(id).transcripts;
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
