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

/** Shells Codex runs a model's command with (`/bin/bash -lc '<script>'`). */
const WRAPPING_SHELLS = new Set(['bash', 'zsh', 'sh']);
/** Characters with a meaning to the shell outside quotes. */
const SHELL_OPERATORS = /[;&|<>()`$*?[\]{}~#!]/;

/**
 * The words of a command line as a POSIX shell splits them, for the
 * quoting Codex writes (single quotes, double quotes with backslash
 * escapes, backslashes); `null` when it uses anything else outside quotes
 * (operators, globs, expansions) or expansions inside double quotes, or
 * the quotes do not end.
 */
export function shellWords(line: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === ' ' || char === '\t' || char === '\n') {
      if (word !== null) {
        words.push(word);
        word = null;
      }
    } else if (char === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) {
        return null;
      }
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let quoted = '';
      for (i++; ; i++) {
        if (i >= line.length) {
          return null;
        }
        const inner = line[i];
        if (inner === '"') {
          break;
        }
        if (inner === '$' || inner === '`') {
          // An expansion: the script is not the literal text.
          return null;
        }
        if (inner === '\\' && i + 1 < line.length) {
          const next = line[i + 1];
          if (next === '\n') {
            i++;
            continue;
          }
          if ('$`"\\'.includes(next)) {
            quoted += next;
            i++;
            continue;
          }
        }
        quoted += inner;
      }
      word = (word ?? '') + quoted;
    } else if (char === '\\') {
      if (i + 1 >= line.length) {
        return null;
      }
      i++;
      if (line[i] !== '\n') {
        word = (word ?? '') + line[i];
      }
    } else if (SHELL_OPERATORS.test(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) {
    words.push(word);
  }
  return words;
}

/**
 * The script of a command Codex reports wrapped in the shell it runs it
 * with (`/bin/bash -lc '<script>'`, also `zsh`/`sh` and `-c`), so tool
 * calls, approvals and the push analysis see what the model wrote; any
 * other command as it is (`exact`: the command line itself says so).
 * `actions`: Codex's parsed actions of the command, used when the quoting
 * cannot be read and they name a single command; then `exact` is
 * `false` (best effort, for display only).
 */
export function shellScript(
  command: string,
  actions?: readonly { type?: string; command?: unknown }[] | null,
): { script: string; exact: boolean } {
  const words = shellWords(command);
  if (words?.length === 3) {
    const shell = words[0].slice(words[0].lastIndexOf('/') + 1);
    return {
      script:
        WRAPPING_SHELLS.has(shell) && (words[1] === '-lc' || words[1] === '-c')
          ? words[2]
          : command,
      exact: true,
    };
  }
  if (
    words === null &&
    /^(\S*\/)?(bash|zsh|sh) -l?c /.test(command) &&
    actions?.length === 1 &&
    typeof actions[0].command === 'string'
  ) {
    return { script: actions[0].command, exact: false };
  }
  return { script: command, exact: true };
}

/** The script of a command (see `shellScript`). */
export function unwrapShellCommand(
  command: string,
  actions?: readonly { type?: string; command?: unknown }[] | null,
): string {
  return shellScript(command, actions).script;
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
        call(item.id, 'Bash', {
          command: unwrapShellCommand(command.command, command.commandActions),
          cwd: command.cwd,
        }),
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
    // A proposed plan (Markdown) is shown like a message.
    case 'plan':
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

/**
 * The metered bucket of the account's plan limits (`limitId`; others, e.g.
 * of a single model, are not the plan's windows).
 */
export const CODEX_MAIN_LIMIT_ID = 'codex';

/** Whether a snapshot is of the plan's main bucket (older servers: no ID). */
export function isMainLimit(snapshot: CodexRateLimitSnapshot): boolean {
  return snapshot.limitId === null || snapshot.limitId === CODEX_MAIN_LIMIT_ID;
}

/**
 * Merges a sparse rolling update into the last snapshot of its bucket:
 * windows and metadata the update leaves out stay as they were.
 */
export function mergeRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot {
  if (!previous) {
    return update;
  }
  return {
    ...previous,
    ...Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== null),
    ),
  } as CodexRateLimitSnapshot;
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

/**
 * The account's plan usage from `account/rateLimits/read`: the main
 * bucket of its per-bucket view, else the single-bucket view.
 */
export function codexPlanUsage(
  single: CodexRateLimitSnapshot,
  byLimitId?: Record<string, CodexRateLimitSnapshot | undefined> | null,
): AgentPlanUsage {
  const snapshot = byLimitId?.[CODEX_MAIN_LIMIT_ID] ?? single;
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

/**
 * The prefix of the client message IDs of input the app itself sends into
 * a running turn (`turn/steer`, e.g. what it ran instead of a command):
 * not the user's, so neither shown nor an anchor.
 */
export const CODEX_APP_INPUT_PREFIX = 'crm-app:';

function isAppInput(message: { clientId: string | null }): boolean {
  return message.clientId?.startsWith(CODEX_APP_INPUT_PREFIX) === true;
}

/** Whether an item had not finished (`inProgress`). */
function unfinished(item: CodexThreadItem): boolean {
  return (item as { status?: unknown }).status === 'inProgress';
}

/**
 * The history entries of a thread's turns. Context and notes of the app
 * went to Codex as additional context, not as input, so a user message is
 * what the user typed. Tools that had not finished when their turn ended
 * show as not finished, those of a running turn without a result. Codex
 * keeps no items of its plan updates (`turn/plan/updated`): the to-do list
 * is not in the history.
 */
export function codexHistory(turns: CodexTurn[]): AgentHistoryEntry[] {
  const entries: AgentHistoryEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        const message = item as Extract<
          CodexThreadItem,
          { type: 'userMessage' }
        >;
        if (isAppInput(message)) {
          continue;
        }
        const id = message.clientId ?? message.id;
        entries.push({
          uuid: id,
          isUserMessage: true,
          events: [{ type: 'user.message', id, text: textOf(message.content) }],
        });
        continue;
      }
      const calls = callEvents(item);
      entries.push({
        uuid: item.id,
        isUserMessage: false,
        events: !unfinished(item)
          ? [...calls, ...completionEvents(item, false)]
          : turn.status === 'inProgress'
            ? calls
            : [
                ...calls,
                ...calls
                  .filter((event) => event.type === 'tool.call')
                  .map(
                    (event): SessionEventInput => ({
                      type: 'tool.result',
                      toolUseId: (event as { toolUseId: string }).toolUseId,
                      isError: true,
                      content: 'Did not finish (the turn ended).',
                      truncated: false,
                      parentToolUseId: null,
                    }),
                  ),
              ],
      });
    }
  }
  return entries;
}

const USAGE_FIELDS = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const;

/** `current - previous` per field; `null` when a field went down. */
function usageDelta(
  current: CodexTokenUsageBreakdown,
  previous: CodexTokenUsageBreakdown | null,
): CodexTokenUsageBreakdown | null {
  const delta = { ...current };
  for (const field of USAGE_FIELDS) {
    delta[field] = current[field] - (previous?.[field] ?? 0);
    if (delta[field] < 0) {
      return null;
    }
  }
  return delta;
}

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

const NO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: 0,
};

/**
 * Turns the notifications of one thread into agent events. Keeps what it
 * needs across notifications: streamed messages, the plan's revisions, the
 * thread's usage per model, the plan limits per bucket and the model.
 *
 * Usage: Codex reports the thread's cumulative total, for all models
 * together, and restores it when a thread is resumed (an update with the
 * total so far right after `thread/resume`, before any turn of this
 * process). Only the growth of the total during this process's turns
 * counts, for the model of the turn; the result carries the cumulative
 * usage per model on top of `usageBaseline` (what the app recorded for
 * the session so far), as the usage tracker expects of an engine.
 */
export class CodexEventTranslator {
  private readonly streamed = new Set<string>();
  private planRevision = 0;
  private usage: CodexThreadTokenUsage | null = null;
  /** The thread's total when it last counted (or was restored). */
  private countedTotal: CodexTokenUsageBreakdown | null = null;
  /** Turns of this process: their usage counts. */
  private readonly turns = new Set<string>();
  /** Cumulative usage per model counted by this process, on the baseline. */
  private readonly byModel = new Map<string, UsageTotals>();
  /** The last snapshot of each limit bucket (updates are sparse). */
  private readonly limits = new Map<string, CodexRateLimitSnapshot>();
  /** The account's usage limit rejected the running turn. */
  private limited = false;

  constructor(
    readonly threadId: string,
    /** The model the thread runs with (usage and context are counted for it). */
    public model: string,
    private readonly usageBaseline: Record<string, UsageTotals> = {},
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
      case 'turn/started': {
        const turn = p['turn'] as { id?: unknown } | undefined;
        if (typeof turn?.id === 'string') {
          this.turns.add(turn.id);
        }
        return [];
      }
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
          if (isAppInput(message)) {
            return [];
          }
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
        this.countUsage(
          p['tokenUsage'] as CodexThreadTokenUsage,
          typeof p['turnId'] === 'string' ? p['turnId'] : null,
        );
        return [];
      case 'account/rateLimits/updated': {
        const update = p['rateLimits'] as CodexRateLimitSnapshot;
        const key = update.limitId ?? CODEX_MAIN_LIMIT_ID;
        const merged = mergeRateLimits(this.limits.get(key), update);
        this.limits.set(key, merged);
        // Only the plan's own bucket is the account's limit windows.
        return isMainLimit(update)
          ? codexRateLimits(merged).map((limit) => ({
              type: 'rate-limit',
              limit,
            }))
          : [];
      }
      case 'error': {
        const error = p['error'] as { codexErrorInfo?: unknown } | undefined;
        if (isUsageLimit(error?.codexErrorInfo)) {
          this.limited = true;
          return [{ type: 'limit-hit' }];
        }
        return [];
      }
      case 'turn/completed': {
        const turn = p['turn'] as CodexTurn;
        // A limit only the turn's own error names still stops the session.
        const unannounced =
          !this.limited && isUsageLimit(turn.error?.codexErrorInfo);
        const result = this.result(turn);
        return unannounced ? [{ type: 'limit-hit' }, result] : [result];
      }
      default:
        return [];
    }
  }

  private countUsage(
    usage: CodexThreadTokenUsage,
    turnId: string | null,
  ): void {
    this.usage = usage;
    const previous = this.countedTotal;
    this.countedTotal = usage.total;
    if (turnId === null || !this.turns.has(turnId)) {
      // The total restored on resume (or another process's turn): so far.
      return;
    }
    // A total that went down starts over (it was reset).
    const delta =
      usageDelta(usage.total, previous) ?? usageDelta(usage.total, null);
    if (!delta) {
      return;
    }
    const totals = codexUsageTotals(delta);
    if (
      totals.inputTokens === 0 &&
      totals.outputTokens === 0 &&
      totals.cacheCreationInputTokens === 0 &&
      totals.cacheReadInputTokens === 0
    ) {
      return;
    }
    const sofar =
      this.byModel.get(this.model) ??
      this.usageBaseline[this.model] ??
      NO_USAGE;
    this.byModel.set(this.model, addUsage(sofar, totals));
  }

  /** Cumulative usage per model, for the turn's result. */
  private modelUsage(): AgentModelUsage {
    return Object.fromEntries(
      [...this.byModel].map(([model, totals]) => [model, { ...totals }]),
    );
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
