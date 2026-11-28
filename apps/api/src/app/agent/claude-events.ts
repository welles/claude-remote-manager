import type {
  CanUseTool,
  ModelInfo,
  PermissionMode,
  PermissionUpdate,
  PermissionUpdateDestination,
  ModelUsage,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKRateLimitInfo,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelOption,
  SlashCommandOption,
  UsageTotals,
} from '@claude-remote-manager/shared-types';
import { SdkEventMapper, transcriptEntries } from './sdk-event-mapper';
import type {
  AgentApprover,
  AgentContextUsage,
  AgentEvent,
  AgentHistoryEntry,
  AgentModelUsage,
  AgentPermissionUpdate,
  AgentPlanUsage,
  AgentPlanWindow,
  AgentRateLimit,
} from './agent-events';

/**
 * The Claude Code adapter's translation of the Agent SDK's types into the
 * engine-neutral model (see `agent-events.ts`).
 */

/** `rate_limit_event` reports reset times as epoch seconds. */
function epochSecondsToIso(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

/** `rate_limit_event` reports utilization as a fraction (0-1). */
function fractionToPercent(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 1000) / 10;
}

/**
 * The plan usage request reports times like `2026-11-13T02:10:00.492006+00:00`;
 * normalized to the ISO form used everywhere else.
 */
function normalizeIso(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toISOString();
}

export function claudeRateLimit(info: SDKRateLimitInfo): AgentRateLimit {
  return {
    window: info.rateLimitType ?? null,
    status: info.status ?? null,
    utilization: fractionToPercent(info.utilization),
    resetsAt: epochSecondsToIso(info.resetsAt),
  };
}

const PLAN_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
] as const;

export function claudePlanUsage(
  usage: SDKControlGetUsageResponse,
): AgentPlanUsage {
  const limits = usage.rate_limits;
  if (!usage.rate_limits_available || !limits) {
    return { subscriptionType: usage.subscription_type, windows: null };
  }
  const windows: AgentPlanWindow[] = [];
  for (const type of PLAN_WINDOWS) {
    const window = limits[type];
    if (window) {
      windows.push({
        window: type,
        label: null,
        utilization: window.utilization,
        resetsAt: normalizeIso(window.resets_at),
      });
    }
  }
  for (const window of limits.model_scoped ?? []) {
    windows.push({
      window: `model:${window.display_name}`,
      label: `Week (${window.display_name})`,
      utilization: window.utilization,
      resetsAt: normalizeIso(window.resets_at),
    });
  }
  return { subscriptionType: usage.subscription_type, windows };
}

export function claudeContextUsage(
  usage: SDKControlGetContextUsageResponse,
): AgentContextUsage {
  return {
    model: usage.model,
    usedTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
  };
}

function usageTotals(usage: ModelUsage): UsageTotals {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    costUsd: usage.costUSD,
  };
}

export function claudeModelUsage(
  usage: Record<string, ModelUsage>,
): AgentModelUsage {
  return Object.fromEntries(
    Object.entries(usage).map(([model, value]) => [model, usageTotals(value)]),
  );
}

export function claudeCommand(command: SlashCommand): SlashCommandOption {
  return {
    name: command.name,
    description: command.description ?? '',
    argumentHint: command.argumentHint ?? '',
    aliases: command.aliases ?? [],
    builtin: command.builtin === true,
  };
}

export function claudeModel(info: ModelInfo): ModelOption {
  return {
    // Claude Code's "default" row stands for not choosing a model.
    value: info.value === 'default' ? null : info.value,
    label: info.displayName || info.value,
    description: info.description ?? '',
    resolvedModel: info.resolvedModel ?? null,
  };
}

/** The history entries of a stored Claude Code transcript. */
export function claudeHistory(messages: SessionMessage[]): AgentHistoryEntry[] {
  return transcriptEntries(messages);
}

/**
 * Turns the messages of one Claude Code process into agent events. Keeps
 * the state of the event mapper (streamed text, file tool calls), so there
 * is one per process.
 */
export class ClaudeEventTranslator {
  private readonly mapper = new SdkEventMapper();

  translate(message: SDKMessage): AgentEvent[] {
    if (message.type === 'system' && message.subtype === 'init') {
      return [
        {
          type: 'started',
          engineSessionId: message.session_id,
          permissionMode: message.permissionMode ?? null,
          terminalCommands: message.terminal_slash_commands ?? [],
        },
      ];
    }
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      return [
        { type: 'commands', commands: message.commands.map(claudeCommand) },
      ];
    }
    if (
      message.type === 'system' &&
      message.subtype === 'background_tasks_changed'
    ) {
      return [
        {
          type: 'background',
          taskIds: message.tasks
            .filter((task) => !task.ambient)
            .map((task) => task.task_id),
        },
      ];
    }
    if (message.type === 'rate_limit_event') {
      return [
        { type: 'rate-limit', limit: claudeRateLimit(message.rate_limit_info) },
      ];
    }
    if (message.type === 'result') {
      return [
        {
          type: 'result',
          subtype: message.subtype,
          isError: message.is_error,
          text: message.subtype === 'success' ? message.result : null,
          errors: message.subtype === 'success' ? [] : message.errors,
          durationMs: message.duration_ms,
          numTurns: message.num_turns,
          usage: claudeModelUsage(message.modelUsage),
          engineSessionId: message.session_id ?? null,
          queuedTurns: message.queued_turn_count ?? 0,
        },
      ];
    }
    if (message.type === 'prompt_suggestion') {
      return [{ type: 'suggestion', events: this.mapper.map(message) }];
    }
    const events: AgentEvent[] = [];
    const mainThread =
      (message.type === 'assistant' || message.type === 'stream_event') &&
      message.parent_tool_use_id === null &&
      !(message.type === 'assistant' && message.agent_id);
    if (mainThread) {
      events.push({ type: 'activity' });
    }
    if (
      message.type === 'system' &&
      message.subtype === 'status' &&
      message.permissionMode
    ) {
      // Claude Code changed the mode itself (e.g. entering plan mode).
      events.push({ type: 'mode', mode: message.permissionMode });
    }
    if (
      message.type === 'assistant' &&
      message.error === 'rate_limit' &&
      message.parent_tool_use_id === null &&
      !message.agent_id
    ) {
      // The usage limit rejected the turn's request: Claude Code ends the
      // turn with this (synthetic) message.
      events.push({ type: 'limit-hit' });
    }
    const output = this.mapper.map(message);
    // Messages of subagents and other agents are not in the session's
    // transcript: an anchor there would place the events at the end of the
    // turn, after later ones (see buildHistory).
    const anchor =
      (message.type === 'assistant' || message.type === 'user') &&
      message.uuid &&
      message.parent_tool_use_id === null &&
      !('agent_id' in message && message.agent_id)
        ? message.uuid
        : null;
    const images = this.mapper.takeImages();
    const contextChanged = message.type === 'assistant';
    if (output.length > 0 || anchor || images.length > 0 || contextChanged) {
      events.push({
        type: 'output',
        events: output,
        anchor,
        images,
        contextChanged,
      });
    }
    return events;
  }
}

function claudePermissionUpdate(
  update: PermissionUpdate,
): AgentPermissionUpdate {
  switch (update.type) {
    case 'addRules':
      return {
        type: 'addRules',
        rules: update.rules.map((rule) => ({
          toolName: rule.toolName,
          ...(rule.ruleContent === undefined
            ? {}
            : { ruleContent: rule.ruleContent }),
        })),
        behavior: update.behavior,
        destination: update.destination,
      };
    case 'addDirectories':
      return {
        type: 'addDirectories',
        directories: update.directories,
        destination: update.destination,
      };
    case 'setMode':
      return {
        type: 'setMode',
        mode: update.mode,
        destination: update.destination,
      };
    default:
      return { type: 'other', raw: update };
  }
}

function sdkPermissionUpdate(
  update: AgentPermissionUpdate,
): PermissionUpdate | null {
  switch (update.type) {
    case 'addRules':
      return {
        type: 'addRules',
        rules: update.rules,
        behavior: update.behavior,
        destination: update.destination as PermissionUpdateDestination,
      };
    case 'addDirectories':
      return {
        type: 'addDirectories',
        directories: update.directories,
        destination: update.destination as PermissionUpdateDestination,
      };
    case 'setMode':
      return {
        type: 'setMode',
        mode: update.mode as PermissionMode,
        destination: update.destination as PermissionUpdateDestination,
      };
    default:
      return null;
  }
}

/** Claude Code's `canUseTool` callback for an engine-neutral approver. */
export function claudeCanUseTool(approve: AgentApprover): CanUseTool {
  return async (toolName, input, options) => {
    const result = await approve({
      toolName,
      input,
      toolUseId: options.toolUseID,
      title: options.title ?? null,
      description: options.description ?? null,
      displayName: options.displayName ?? null,
      decisionReason: options.decisionReason ?? null,
      blockedPath: options.blockedPath ?? null,
      agentId: options.agentID ?? null,
      mcpServer: options.mcpServer ?? null,
      suggestions: (options.suggestions ?? []).map(claudePermissionUpdate),
      suppressAlwaysAllow: options.suppressAlwaysAllowRule === true,
      signal: options.signal,
    });
    if (result.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: result.message,
        ...(result.interrupt ? { interrupt: true } : {}),
      };
    }
    const updates = (result.updatedPermissions ?? [])
      .map(sdkPermissionUpdate)
      .filter((update): update is PermissionUpdate => update !== null);
    return {
      behavior: 'allow',
      ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
      ...(updates.length > 0 ? { updatedPermissions: updates } : {}),
    };
  };
}
