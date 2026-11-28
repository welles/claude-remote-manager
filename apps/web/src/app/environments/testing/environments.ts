import type {
  EnginePresets,
  EnvironmentPresets,
} from '@claude-remote-manager/shared-types';

const NONE: EnginePresets = { model: null, permissionMode: null };

/** An environment's presets: Claude Code's and Codex's, none by default. */
export function enginePresets(
  claudeCode: Partial<EnginePresets> = {},
  codex: Partial<EnginePresets> = {},
): EnvironmentPresets {
  return {
    'claude-code': { ...NONE, ...claudeCode },
    codex: { ...NONE, ...codex },
  };
}
