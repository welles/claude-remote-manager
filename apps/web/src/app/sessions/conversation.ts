import {
  PERMISSION_MODE_INFO,
  type AssistantDraft,
  type FileDiff,
  type PermissionRequestEvent,
  type PermissionResolvedEvent,
  type PrepareProgressEvent,
  type SessionEvent,
  type SettingsChangedEvent,
  type SetupResultEvent,
  type ToolDiffSource,
  type UsageTotals,
} from '@claude-remote-manager/shared-types';

/** An approval request of a tool use and, once decided, its resolution. */
export interface ToolPermission {
  request: PermissionRequestEvent;
  resolved: PermissionResolvedEvent | null;
}

/** One entry of the rendered conversation. */
export type ConversationItem =
  | { kind: 'user'; key: string; text: string }
  | {
      kind: 'assistant';
      key: string;
      text: string;
      streaming: boolean;
      nested: boolean;
    }
  | {
      kind: 'tool';
      key: string;
      name: string;
      summary: string;
      input: unknown;
      nested: boolean;
      result: { isError: boolean; content: string; truncated: boolean } | null;
      /** Set when the tool use was denied without asking the user. */
      denied: string | null;
      /** Set when the user was asked (approval, question or plan). */
      permission: ToolPermission | null;
      /** What the call changed in a file (`Edit`, `Write`, ...). */
      diff: { diff: FileDiff; source: ToolDiffSource } | null;
    }
  | {
      /**
       * A message sent while Claude worked: waiting in the queue, or
       * withdrawn (not sent) when the turn was stopped or the session ended.
       */
      kind: 'queued';
      key: string;
      id: string;
      text: string;
      state: 'queued' | 'withdrawn';
      reason: string | null;
    }
  | { kind: 'settings'; key: string; text: string }
  | { kind: 'notice'; key: string; level: 'info' | 'warning'; text: string }
  | { kind: 'error'; key: string; text: string }
  | {
      kind: 'turn';
      key: string;
      usage: UsageTotals;
      durationMs: number;
      interrupted: boolean;
    }
  | {
      /** A step of the preparation; later states replace earlier ones. */
      kind: 'progress';
      key: string;
      step: PrepareProgressEvent['step'];
      state: PrepareProgressEvent['state'];
      target: string | null;
      path: string | null;
      message: string | null;
    }
  | {
      /** A setup script with its output. */
      kind: 'setup';
      key: string;
      repository: string;
      path: string | null;
      state: SetupResultEvent['state'];
      output: string;
      exitCode: number | null;
      durationMs: number | null;
      message: string | null;
      outputTail: string | null;
    };

const MAX_SUMMARY_LENGTH = 120;

/** Short description of a tool call's input, e.g. the command or file. */
export function toolSummary(name: string, input: unknown): string {
  const fields =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const preferred = [
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
    'prompt',
  ];
  const key = preferred.find((field) => typeof fields[field] === 'string');
  const special = specialSummary(name, fields);
  let summary =
    special !== null
      ? special
      : key
        ? String(fields[key])
        : input === null || input === undefined
          ? ''
          : JSON.stringify(input);
  summary = summary.replace(/\s+/g, ' ').trim();
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : summary;
}

/** Summaries of tools whose input has no telling text field. */
function specialSummary(
  name: string,
  fields: Record<string, unknown>,
): string | null {
  switch (name) {
    case 'AskUserQuestion': {
      const questions = Array.isArray(fields['questions'])
        ? (fields['questions'] as { question?: unknown }[])
        : [];
      return questions.map((item) => String(item.question ?? '')).join(' · ');
    }
    case 'ExitPlanMode':
      return 'Plan for approval';
    case 'TaskCreate':
      return typeof fields['subject'] === 'string' ? fields['subject'] : null;
    case 'TaskUpdate':
      return `#${String(fields['taskId'] ?? '?')}${
        typeof fields['status'] === 'string' ? ` → ${fields['status']}` : ''
      }`;
    case 'TodoWrite':
      return Array.isArray(fields['todos'])
        ? `${fields['todos'].length} tasks`
        : null;
    default:
      return null;
  }
}

const replaceAt = <T>(items: T[], index: number, item: T): T[] => [
  ...items.slice(0, index),
  item,
  ...items.slice(index + 1),
];

/**
 * Applies a session event to the conversation. Returns a new array when
 * something changed (so signals notice), otherwise the same one.
 */
export function applyEvent(
  items: ConversationItem[],
  event: SessionEvent,
): ConversationItem[] {
  switch (event.type) {
    case 'user.message':
      return [
        ...items,
        { kind: 'user', key: `user:${event.id}`, text: event.text },
      ];
    case 'assistant.delta': {
      const key = `text:${event.messageId}:${event.blockIndex}`;
      const index = items.findIndex((item) => item.key === key);
      const existing = items[index];
      if (existing?.kind === 'assistant') {
        return replaceAt(items, index, {
          ...existing,
          text: existing.text + event.text,
        });
      }
      return [
        ...items,
        {
          kind: 'assistant',
          key,
          text: event.text,
          streaming: true,
          nested: event.parentToolUseId !== null,
        },
      ];
    }
    case 'assistant.text': {
      const key =
        event.blockIndex === null
          ? `text:${event.messageId}:seq${event.seq}`
          : `text:${event.messageId}:${event.blockIndex}`;
      const item: ConversationItem = {
        kind: 'assistant',
        key,
        text: event.text,
        streaming: false,
        nested: event.parentToolUseId !== null,
      };
      const index = items.findIndex((existing) => existing.key === key);
      return index >= 0 ? replaceAt(items, index, item) : [...items, item];
    }
    case 'tool.call': {
      const key = `tool:${event.toolUseId}`;
      const index = items.findIndex((item) => item.key === key);
      const existing = items[index];
      const item: ConversationItem = {
        kind: 'tool',
        key,
        name: event.name,
        summary: toolSummary(event.name, event.input),
        input: event.input,
        nested: event.parentToolUseId !== null,
        result: existing?.kind === 'tool' ? existing.result : null,
        denied: existing?.kind === 'tool' ? existing.denied : null,
        permission: existing?.kind === 'tool' ? existing.permission : null,
        diff: existing?.kind === 'tool' ? existing.diff : null,
      };
      return index >= 0 ? replaceAt(items, index, item) : [...items, item];
    }
    case 'tool.result': {
      const index = items.findIndex(
        (item) => item.key === `tool:${event.toolUseId}`,
      );
      const existing = items[index];
      if (existing?.kind !== 'tool') {
        return items;
      }
      return replaceAt(items, index, {
        ...existing,
        result: {
          isError: event.isError,
          content: event.content,
          truncated: event.truncated,
        },
      });
    }
    case 'tool.diff': {
      const index = items.findIndex(
        (item) => item.key === `tool:${event.toolUseId}`,
      );
      const existing = items[index];
      if (existing?.kind !== 'tool') {
        return items;
      }
      return replaceAt(items, index, {
        ...existing,
        diff: { diff: event.diff, source: event.source },
      });
    }
    case 'permission.denied': {
      const key = `tool:${event.toolUseId}`;
      const index = items.findIndex((item) => item.key === key);
      const existing = items[index];
      if (existing?.kind === 'tool') {
        return replaceAt(items, index, { ...existing, denied: event.message });
      }
      return [
        ...items,
        {
          kind: 'tool',
          key,
          name: event.toolName,
          summary: toolSummary(event.toolName, event.input),
          input: event.input,
          nested: false,
          result: null,
          denied: event.message,
          permission: null,
          diff: null,
        },
      ];
    }
    case 'permission.request': {
      const key = `tool:${event.toolUseId}`;
      const index = items.findIndex((item) => item.key === key);
      const existing = items[index];
      const permission: ToolPermission = { request: event, resolved: null };
      if (existing?.kind === 'tool') {
        return replaceAt(items, index, { ...existing, permission });
      }
      // Claude Code may ask before the assistant message is complete.
      return [
        ...items,
        {
          kind: 'tool',
          key,
          name: event.toolName,
          summary: toolSummary(event.toolName, event.input),
          input: event.input,
          nested: event.agentId !== null,
          result: null,
          denied: null,
          permission,
          diff: null,
        },
      ];
    }
    case 'permission.resolved': {
      const index = items.findIndex(
        (item) =>
          item.kind === 'tool' &&
          item.permission?.request.requestId === event.requestId,
      );
      const existing = items[index];
      if (existing?.kind !== 'tool' || !existing.permission) {
        return items;
      }
      return replaceAt(items, index, {
        ...existing,
        permission: { ...existing.permission, resolved: event },
      });
    }
    case 'message.queued':
      return [
        ...items.filter((item) => item.key !== `queued:${event.id}`),
        {
          kind: 'queued',
          key: `queued:${event.id}`,
          id: event.id,
          text: event.text,
          state: 'queued',
          reason: null,
        },
      ];
    case 'message.dequeued': {
      const index = items.findIndex(
        (item) => item.key === `queued:${event.id}`,
      );
      const existing = items[index];
      if (existing?.kind !== 'queued') {
        return items;
      }
      if (event.outcome !== 'withdrawn') {
        return items.filter((_, i) => i !== index);
      }
      return replaceAt(items, index, {
        ...existing,
        state: 'withdrawn',
        reason: event.reason,
      });
    }
    case 'settings.changed':
      return [
        ...items,
        {
          kind: 'settings',
          key: `settings:${event.seq}`,
          text: settingsText(event),
        },
      ];
    case 'turn.result':
      return [
        ...items,
        {
          kind: 'turn',
          key: `turn:${event.seq}`,
          usage: event.usage,
          durationMs: event.durationMs,
          interrupted: event.interrupted,
        },
      ];
    case 'notice':
      return [
        ...items,
        {
          kind: 'notice',
          key: `notice:${event.seq}`,
          level: event.level,
          text: event.text,
        },
      ];
    case 'error':
      return [
        ...items,
        { kind: 'error', key: `error:${event.seq}`, text: event.message },
      ];
    case 'prepare.progress': {
      const key =
        event.step === 'rollback'
          ? `prepare:rollback:${event.path ?? event.seq}`
          : `prepare:${event.step}:${event.target ?? ''}`;
      const item: ConversationItem = {
        kind: 'progress',
        key,
        step: event.step,
        state: event.state,
        target: event.target,
        path: event.path,
        message: event.message,
      };
      const index = items.findIndex((existing) => existing.key === key);
      return index >= 0 ? replaceAt(items, index, item) : [...items, item];
    }
    case 'setup.output': {
      const key = `setup:${event.repository}`;
      const index = items.findIndex((existing) => existing.key === key);
      const existing = items[index];
      if (existing?.kind === 'setup') {
        return replaceAt(items, index, {
          ...existing,
          output: existing.output + event.text,
        });
      }
      return [
        ...items,
        {
          kind: 'setup',
          key,
          repository: event.repository,
          path: null,
          state: 'started',
          output: event.text,
          exitCode: null,
          durationMs: null,
          message: null,
          outputTail: null,
        },
      ];
    }
    case 'setup.result': {
      const key = `setup:${event.repository}`;
      const index = items.findIndex((existing) => existing.key === key);
      const existing = items[index];
      const item: ConversationItem = {
        kind: 'setup',
        key,
        repository: event.repository,
        path: event.path,
        state: event.state,
        output: existing?.kind === 'setup' ? existing.output : '',
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        message: event.message,
        outputTail: event.outputTail,
      };
      return index >= 0 ? replaceAt(items, index, item) : [...items, item];
    }
    default:
      // Status, context usage and reserved permission events are shown
      // elsewhere or not yet.
      return items;
  }
}

/** One line describing a change of model or permission mode. */
export function settingsText(event: SettingsChangedEvent): string {
  const parts: string[] = [];
  if (event.model !== undefined) {
    parts.push(`Model: ${event.model ?? 'default'}`);
  }
  if (event.permissionMode) {
    parts.push(`Mode: ${PERMISSION_MODE_INFO[event.permissionMode].label}`);
  }
  const by =
    event.cause === 'plan'
      ? ' (plan approved)'
      : event.cause === 'claude'
        ? ' (changed by Claude)'
        : '';
  return `${parts.join(' · ')}${by}`;
}

/** Approval requests that wait for an answer, oldest first. */
export function pendingRequests(
  items: ConversationItem[],
): PermissionRequestEvent[] {
  const pending: PermissionRequestEvent[] = [];
  for (const item of items) {
    if (item.kind === 'tool' && item.permission && !item.permission.resolved) {
      pending.push(item.permission.request);
    }
  }
  return pending;
}

/** One line describing a preparation step. */
export function progressText(
  item: Extract<ConversationItem, { kind: 'progress' }>,
): string {
  const target = item.target ?? '';
  const detail = item.message ? ` · ${item.message}` : '';
  if (item.state === 'failed') {
    return item.message ?? `${item.step} of ${target} failed`;
  }
  switch (item.step) {
    case 'fetch':
      return item.state === 'started'
        ? `Updating ${target}…`
        : `Updated ${target}${detail}`;
    case 'clone':
      return item.state === 'started'
        ? `Cloning ${target} for this session…`
        : `Cloned ${target}${detail}`;
    case 'scratch':
      return item.state === 'started'
        ? 'Creating the scratch directory…'
        : `Created the scratch directory ${item.path ?? ''}`;
    case 'rollback':
      return `Removed ${target || item.path || 'the directory'} again`;
    case 'done':
      return 'Ready. The message went to Claude.';
  }
}

/** Shows the streamed text of a block, replacing what the client had. */
export function applyDraft(
  items: ConversationItem[],
  draft: AssistantDraft,
): ConversationItem[] {
  const key = `text:${draft.messageId}:${draft.blockIndex}`;
  const item: ConversationItem = {
    kind: 'assistant',
    key,
    text: draft.text,
    streaming: true,
    nested: draft.parentToolUseId !== null,
  };
  const index = items.findIndex((existing) => existing.key === key);
  return index >= 0 ? replaceAt(items, index, item) : [...items, item];
}

export function buildConversation(events: SessionEvent[]): ConversationItem[] {
  return events.reduce(applyEvent, [] as ConversationItem[]);
}

const CANCELLED: Record<string, string> = {
  interrupted: 'Cancelled: the turn was stopped',
  ended: 'Cancelled: the session was ended',
  process_exit: 'Cancelled: Claude Code ended',
  restart: 'Cancelled: the server stopped',
};

/** How an approval request was decided, in a few words. */
export function resolutionText(permission: ToolPermission): string {
  const { request, resolved } = permission;
  if (!resolved) {
    return request.kind === 'question'
      ? 'Waiting for your answer'
      : request.kind === 'plan'
        ? 'Waiting for your approval of the plan'
        : 'Waiting for your approval';
  }
  if (resolved.cause !== 'user') {
    return CANCELLED[resolved.cause] ?? 'Cancelled';
  }
  const said = resolved.message ? `: ${resolved.message}` : '';
  if (resolved.decision === 'deny') {
    switch (request.kind) {
      case 'question':
        return `Not answered${said}`;
      case 'plan':
        return `Kept planning${said}`;
      default:
        return `Denied${said}`;
    }
  }
  switch (request.kind) {
    case 'question':
      return 'Answered';
    case 'plan':
      return `Plan approved, continuing in mode ${PERMISSION_MODE_INFO[resolved.mode ?? 'default'].label}`;
    default:
      return resolved.scope === 'session'
        ? 'Allowed for this session'
        : 'Allowed once';
  }
}
