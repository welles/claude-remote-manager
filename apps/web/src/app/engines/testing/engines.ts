import type { HttpTestingController } from '@angular/common/http/testing';
import {
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  ENGINE_LABELS,
  ENGINE_PROVIDERS,
  type AgentEngineDto,
  type AgentEngineId,
  type EngineListResponse,
} from '@claude-remote-manager/shared-types';

/** An engine as `GET /api/engines` lists it. */
export function engineDto(id: AgentEngineId): AgentEngineDto {
  return {
    id,
    label: ENGINE_LABELS[id],
    provider: ENGINE_PROVIDERS[id],
    capabilities:
      id === 'codex'
        ? {
            permissionModes: [...CODEX_PERMISSION_MODES],
            planMode: false,
            slashCommands: false,
            contextUsage: true,
            addDirectories: true,
          }
        : {
            permissionModes: [...CLAUDE_CODE_PERMISSION_MODES],
            planMode: true,
            slashCommands: true,
            contextUsage: true,
            addDirectories: true,
          },
  };
}

/** `GET /api/engines` of a server with these engines. */
export function engineList(...ids: AgentEngineId[]): EngineListResponse {
  return {
    engines: (ids.length > 0 ? ids : (['claude-code'] as const)).map(engineDto),
  };
}

/** Answers the pending `GET /api/engines` (Claude Code alone by default). */
export function flushEngines(
  http: HttpTestingController,
  ...ids: AgentEngineId[]
): void {
  http.expectOne('/api/engines').flush(engineList(...ids));
}
