import { parsePatch } from 'diff';
import {
  MAX_TOOL_DIFF_LINES,
  type DiffHunk,
  type ModelOption,
  type SessionEventInput,
  type UsageTotals,
} from '@claude-remote-manager/shared-types';
import { fileDiff } from '../../diffs/file-diff';
import { MAX_TOOL_RESULT_LENGTH } from '../sdk-event-mapper';
import type {
  AgentContextUsage,
  AgentEvent,
  AgentHistoryEntry,
  AgentModelUsage,
  AgentPlanUsage,
  AgentPlanWindow,
  AgentRateLimit,
} from '../agent-events';
import {
  isUsageLimit,
  type CodexFileUpdateChange,
  type CodexModel,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindow,
  type CodexThreadItem,
  type CodexThreadTokenUsage,
  type CodexTokenUsageBreakdown,
  type CodexTurn,
  type CodexUserInput,
} from './codex-protocol';

/**
 * The Codex adapter's translation of the app server's items and
 * notifications into the engine-neutral model (see `agent-events.ts`).
 * Tools appear under the names the app knows: commands as `Bash`, file
 * changes as `Write`/`Edit` with their diff, the plan as `TodoWrite`, the
 * app's own tools as `mcp__crm__<name>`.
 */

/** The namespace of the app's own tools in Codex (`mcp__crm__…` for the app). */
export const CODEX_APP_TOOL_NAMESPACE = 'crm';

function truncate(text: string): { content: string; truncated: boolean } {
  return text.length > MAX_TOOL_RESULT_LENGTH
    ? { content: text.slice(0, MAX_TOOL_RESULT_LENGTH), truncated: true }
    : { content: text, truncated: false };
}

/** The tool name the app knows for a Codex tool. */
export function codexToolName(namespace: string | null, tool: string): string {
  return `mcp__${namespace ?? CODEX_APP_TOOL_NAMESPACE}__${tool}`;
}

function textOf(content: CodexUserInput[]): string {
  return content
    .filter(
      (
        input,
      ): input is { type: 'text'; text: string; text_elements: unknown[] } =>
        input.type === 'text' && typeof input['text'] === 'string',
    )
    .map((input) => input.text)
    .join('\n');
}

function resultText(content: unknown[]): string {
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : JSON.stringify(block),
    )
    .join('\n');
}

/** The diff of one change of a `fileChange` item. */
export function codexChangeDiff(change: CodexFileUpdateChange) {
  let hunks: DiffHunk[] = [];
  try {
    const [patch] = parsePatch(change.diff);
    hunks = (patch?.hunks ?? []).map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines,
    }));
  } catch {
    hunks = [];
  }
  if (hunks.length === 0 && change.kind.type === 'add' && change.diff) {
    // A new file may come as its plain content.
    const lines = change.diff.replace(/\n$/, '').split('\n');
    hunks = [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((line) => `+${line}`),
      },
    ];
  }
  const status =
    change.kind.type === 'add'
      ? 'added'
      : change.kind.type === 'delete'
        ? 'deleted'
        : change.kind.move_path
          ? 'renamed'
          : 'modified';
  const path =
    change.kind.type === 'update' && change.kind.move_path
      ? change.kind.move_path
      : change.path;
  return fileDiff(path, status, hunks, {
    maxLines: MAX_TOOL_DIFF_LINES,
    oldPath: path === change.path ? null : change.path,
  });
}

/** The tool call(s) an item starts. */
function callEvents(item: CodexThreadItem): SessionEventInput[] {
  const call = (toolUseId: string, name: string, input: unknown) =>
    ({
      type: 'tool.call',
      messageId: item.id,
      toolUseId,
      name,
      input,
      parentToolUseId: null,
    }) as const;
  switch (item.type) {
    case 'commandExecution': {
      const command = item as Extract<
        CodexThreadItem,
        { type: 'commandExecution' }
      >;
      return [
        call(item.id, 'Bash', { command: command.command, cwd: command.cwd }),
      ];
    }
    case 'fileChange': {
      const change = item as Extract<CodexThreadItem, { type: 'fileChange' }>;
      return change.changes.flatMap((entry, index) => {
        const toolUseId = `${item.id}:${index}`;
        return [
          call(toolUseId, entry.kind.type === 'add' ? 'Write' : 'Edit', {
            file_path: entry.path,
          }),
          {
            type: 'tool.diff',
            toolUseId,
            diff: codexChangeDiff(entry),
            source: 'result',
            parentToolUseId: null,
          } as const,
        ];
      });
    }
    case 'mcpToolCall': {
      const tool = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>;
      return [
        call(item.id, codexToolName(tool.server, tool.tool), tool.arguments),
      ];
    }
    case 'dynamicToolCall': {
      const tool = item as Extract<
        CodexThreadItem,
        { type: 'dynamicToolCall' }
      >;
      return [
        call(item.id, codexToolName(tool.namespace, tool.tool), tool.arguments),
      ];
    }
    case 'webSearch':
      return [
        call(item.id, 'WebSearch', {
          query: (item as { query?: string }).query ?? '',
        }),
      ];
    case 'imageView':
      return [
        call(item.id, 'Read', {
          file_path: (item as { path: string }).path,
        }),
      ];
    default:
      return [];
  }
}

/** The results (and final texts) a completed item gives. */
function completionEvents(
  item: CodexThreadItem,
  streamed: boolean,
): SessionEventInput[] {
  const result = (toolUseId: string, isError: boolean, text: string) =>
    ({
      type: 'tool.result',
      toolUseId,
      isError,
      ...truncate(text),
      parentToolUseId: null,
    }) as const;
  switch (item.type) {
    case 'agentMessage': {
      const text = (item as { text: string }).text;
      return text
        ? [
            {
              type: 'assistant.text',
              messageId: item.id,
              blockIndex: streamed ? 0 : null,
              text,
              parentToolUseId: null,
            },
          ]
        : [];
    }
    case 'commandExecution': {
      const command = item as Extract<
        CodexThreadItem,
        { type: 'commandExecution' }
      >;
      const failed =
        command.status === 'failed' ||
        command.status === 'declined' ||
        (command.exitCode !== null && command.exitCode !== 0);
      return [
        result(
          item.id,
          failed,
          command.aggregatedOutput ??
            (command.status === 'declined' ? 'Declined' : ''),
        ),
      ];
    }
    case 'fileChange': {
      const change = item as Extract<CodexThreadItem, { type: 'fileChange' }>;
      const failed = change.status !== 'completed';
      return change.changes.map((entry, index) =>
        result(
          `${item.id}:${index}`,
          failed,
          failed ? `Not applied (${change.status})` : `Changed ${entry.path}`,
        ),
      );
    }
    case 'mcpToolCall': {
      const tool = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>;
      return [
        result(
          item.id,
          tool.error !== null,
          tool.error?.message ?? resultText(tool.result?.content ?? []),
        ),
      ];
    }
    case 'dynamicToolCall': {
      const tool = item as Extract<
        CodexThreadItem,
        { type: 'dynamicToolCall' }
      >;
      return [
        result(
          item.id,
          tool.success === false,
          (tool.contentItems ?? [])
            .map((entry) =>
              entry.type === 'inputText'
                ? (entry as { text: string }).text
                : '',
            )
            .join('\n'),
        ),
      ];
    }
    case 'webSearch':
    case 'imageView':
      return [result(item.id, false, '')];
    case 'contextCompaction':
      return [
        {
          type: 'notice',
          level: 'info',
          text: 'Codex compacted the conversation to free context.',
        },
      ];
    default:
      return [];
  }
}

/** The plan as Claude Code's `TodoWrite` (the todo panel reads it). */
function planEvents(
  turnId: string,
  revision: number,
  plan: { step: string; status: string }[],
): SessionEventInput[] {
  const toolUseId = `${turnId}:plan:${revision}`;
  return [
    {
      type: 'tool.call',
      messageId: toolUseId,
      toolUseId,
      name: 'TodoWrite',
      input: {
        todos: plan.map((step) => ({
          content: step.step,
          activeForm: step.step,
          status:
            step.status === 'inProgress'
              ? 'in_progress'
              : step.status === 'completed'
                ? 'completed'
                : 'pending',
        })),
      },
      parentToolUseId: null,
    },
    {
      type: 'tool.result',
      toolUseId,
      isError: false,
      content: 'Plan updated',
      truncated: false,
      parentToolUseId: null,
    },
  ];
}

/** Codex's token counts as the app's usage totals (no API cost). */
export function codexUsageTotals(usage: CodexTokenUsageBreakdown): UsageTotals {
  return {
    inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheWriteInputTokens,
    cacheReadInputTokens: usage.cachedInputTokens,
    costUsd: 0,
  };
}

function windowName(window: CodexRateLimitWindow, fallback: string): string {
  switch (window.windowDurationMins) {
    case 300:
      return 'five_hour';
    case 10080:
      return 'seven_day';
    default:
      return fallback;
  }
}

function epochToIso(value: number | null): string | null {
  return value === null || !Number.isFinite(value)
    ? null
    : new Date(value * 1000).toISOString();
}

function windowsOf(
  snapshot: CodexRateLimitSnapshot,
): { name: string; window: CodexRateLimitWindow }[] {
  const windows: { name: string; window: CodexRateLimitWindow }[] = [];
  if (snapshot.primary) {
    windows.push({
      name: windowName(snapshot.primary, 'primary'),
      window: snapshot.primary,
    });
  }
  if (snapshot.secondary) {
    windows.push({
      name: windowName(snapshot.secondary, 'secondary'),
      window: snapshot.secondary,
    });
  }
  return windows;
}

/** The limit windows of a rate limit update. */
export function codexRateLimits(
  snapshot: CodexRateLimitSnapshot,
): AgentRateLimit[] {
  return windowsOf(snapshot).map(({ name, window }) => ({
    window: name,
    status: window.usedPercent >= 100 ? 'rejected' : 'allowed',
    utilization: window.usedPercent,
    resetsAt: epochToIso(window.resetsAt),
  }));
}

/** The account's plan usage from `account/rateLimits/read`. */
export function codexPlanUsage(
  snapshot: CodexRateLimitSnapshot,
): AgentPlanUsage {
  const windows: AgentPlanWindow[] = windowsOf(snapshot).map(
    ({ name, window }) => ({
      window: name,
      label:
        name === 'primary'
          ? 'Primary window'
          : name === 'secondary'
            ? 'Secondary window'
            : null,
      utilization: window.usedPercent,
      resetsAt: epochToIso(window.resetsAt),
    }),
  );
  return { subscriptionType: snapshot.planType, windows };
}

export function codexContextUsage(
  usage: CodexThreadTokenUsage,
  model: string,
): AgentContextUsage | null {
  if (!usage.modelContextWindow) {
    return null;
  }
  const used = usage.last.totalTokens;
  return {
    model,
    usedTokens: used,
    maxTokens: usage.modelContextWindow,
    percentage: Math.round((used / usage.modelContextWindow) * 1000) / 10,
  };
}

export function codexModel(model: CodexModel): ModelOption {
  return {
    value: model.isDefault ? null : model.model,
    label: model.displayName || model.model,
    description: model.description ?? '',
    resolvedModel: model.model,
  };
}

/** The history entries of a thread's turns. */
export function codexHistory(turns: CodexTurn[]): AgentHistoryEntry[] {
  const entries: AgentHistoryEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        const message = item as Extract<
          CodexThreadItem,
          { type: 'userMessage' }
        >;
        const id = message.clientId ?? message.id;
        entries.push({
          uuid: id,
          isUserMessage: true,
          events: [{ type: 'user.message', id, text: textOf(message.content) }],
        });
        continue;
      }
      entries.push({
        uuid: item.id,
        isUserMessage: false,
        events: [...callEvents(item), ...completionEvents(item, false)],
      });
    }
  }
  return entries;
}

/**
 * Turns the notifications of one thread into agent events. Keeps what it
 * needs across notifications: streamed messages, the plan's revisions, the
 * thread's cumulative usage and the model.
 */
export class CodexEventTranslator {
  private readonly streamed = new Set<string>();
  private planRevision = 0;
  private usage: CodexThreadTokenUsage | null = null;
  /** The account's usage limit rejected the running turn. */
  private limited = false;

  constructor(
    readonly threadId: string,
    /** The model the thread runs with (usage and context are counted for it). */
    public model: string,
  ) {}

  /** The latest token usage (for the context meter). */
  get tokenUsage(): CodexThreadTokenUsage | null {
    return this.usage;
  }

  translate(method: string, params: unknown): AgentEvent[] {
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p['threadId'] === 'string' && p['threadId'] !== this.threadId) {
      // Another thread's (e.g. a subagent's): not this conversation.
      return [];
    }
    switch (method) {
      case 'item/started': {
        const item = p['item'] as CodexThreadItem;
        const events = callEvents(item);
        return [
          { type: 'activity' },
          ...(events.length > 0 ? [this.output(events, item.id)] : []),
        ];
      }
      case 'item/agentMessage/delta': {
        const itemId = String(p['itemId']);
        this.streamed.add(itemId);
        return [
          { type: 'activity' },
          this.output(
            [
              {
                type: 'assistant.delta',
                messageId: itemId,
                blockIndex: 0,
                text: String(p['delta'] ?? ''),
                parentToolUseId: null,
              },
            ],
            null,
          ),
        ];
      }
      case 'item/completed': {
        const item = p['item'] as CodexThreadItem;
        if (item.type === 'userMessage') {
          const message = item as Extract<
            CodexThreadItem,
            { type: 'userMessage' }
          >;
          // The app shows the user's message itself; it anchors what follows.
          return [this.output([], message.clientId ?? message.id)];
        }
        const events = completionEvents(item, this.streamed.delete(item.id));
        return events.length > 0
          ? [this.output(events, item.id, item.type === 'agentMessage')]
          : [];
      }
      case 'turn/plan/updated': {
        const plan = (p['plan'] ?? []) as { step: string; status: string }[];
        return [
          this.output(
            planEvents(String(p['turnId']), this.planRevision++, plan),
            null,
          ),
        ];
      }
      case 'thread/tokenUsage/updated':
        this.usage = p['tokenUsage'] as CodexThreadTokenUsage;
        return [];
      case 'account/rateLimits/updated':
        return codexRateLimits(p['rateLimits'] as CodexRateLimitSnapshot).map(
          (limit) => ({ type: 'rate-limit', limit }),
        );
      case 'error': {
        const error = p['error'] as { codexErrorInfo?: unknown } | undefined;
        if (isUsageLimit(error?.codexErrorInfo)) {
          this.limited = true;
          return [{ type: 'limit-hit' }];
        }
        return [];
      }
      case 'turn/completed':
        return [this.result(p['turn'] as CodexTurn)];
      default:
        return [];
    }
  }

  /** Cumulative usage of the thread, for the turn's result. */
  private modelUsage(): AgentModelUsage {
    return this.usage
      ? { [this.model]: codexUsageTotals(this.usage.total) }
      : {};
  }

  private result(turn: CodexTurn): AgentEvent {
    const failed = turn.status === 'failed';
    const limited = this.limited || isUsageLimit(turn.error?.codexErrorInfo);
    this.limited = false;
    const message = turn.error?.message ?? null;
    return {
      type: 'result',
      subtype: 'success',
      isError: failed,
      text: failed
        ? limited
          ? message || 'The usage limit of the ChatGPT account was reached.'
          : message || 'The turn failed.'
        : null,
      errors: [],
      durationMs: turn.durationMs ?? 0,
      numTurns: 1,
      usage: this.modelUsage(),
      engineSessionId: this.threadId,
      queuedTurns: 0,
    };
  }

  private output(
    events: SessionEventInput[],
    anchor: string | null,
    contextChanged = false,
  ): AgentEvent {
    return { type: 'output', events, anchor, images: [], contextChanged };
  }
}
