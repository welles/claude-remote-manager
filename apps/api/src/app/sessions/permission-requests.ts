import { BadRequestException } from '@nestjs/common';
import type {
  PermissionResult,
  PermissionRuleValue,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  PermissionRequestKind,
  PermissionResolutionCause,
  PlanApprovalMode,
  SessionAllowOffer,
  UserQuestion,
} from '@claude-remote-manager/shared-types';
import type {
  PermissionRequestInput,
  PermissionResolvedInput,
  ToolApprovalRequest,
} from '../agent/tool-approval';
import {
  optionalEnum,
  optionalString,
  requireObject,
} from '../common/validation';
import type { StoredEvent } from './session-event.repository';

/** Claude Code's question tool and the tools of plan mode. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';
export const ENTER_PLAN_MODE_TOOL = 'EnterPlanMode';

const MAX_MESSAGE_LENGTH = 10_000;
const PLAN_MODES: readonly PlanApprovalMode[] = ['default', 'acceptEdits'];

/** Told to Claude when the user denies without saying why: the turn stops. */
export const DENIED_STOP_MESSAGE =
  "The user denied this tool use. It was not run. Stop here and wait for the user's next message.";

export function requestKind(toolName: string): PermissionRequestKind {
  if (toolName === ASK_USER_QUESTION_TOOL) {
    return 'question';
  }
  if (toolName === EXIT_PLAN_MODE_TOOL) {
    return 'plan';
  }
  return 'tool';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The questions of an `AskUserQuestion` call, `null` if malformed. */
export function parseQuestions(
  input: Record<string, unknown>,
): UserQuestion[] | null {
  const raw = input['questions'];
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const questions: UserQuestion[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item['question'] !== 'string') {
      return null;
    }
    const options = Array.isArray(item['options'])
      ? item['options'].filter(isRecord).map((option) => ({
          label: String(option['label'] ?? ''),
          description: String(option['description'] ?? ''),
          preview:
            typeof option['preview'] === 'string' ? option['preview'] : null,
        }))
      : [];
    questions.push({
      question: item['question'],
      header: typeof item['header'] === 'string' ? item['header'] : '',
      options,
      multiSelect: item['multiSelect'] === true,
    });
  }
  return questions;
}

/** The plan of an `ExitPlanMode` call (Markdown), if Claude Code sent it. */
export function planText(input: Record<string, unknown>): string | null {
  return typeof input['plan'] === 'string' && input['plan'].trim()
    ? input['plan']
    : null;
}

/** A permission rule as Claude Code writes it, e.g. `Bash(npm test:*)`. */
export function ruleString(rule: PermissionRuleValue): string {
  return rule.ruleContent === undefined
    ? rule.toolName
    : `${rule.toolName}(${rule.ruleContent})`;
}

/**
 * Whether a session-wide allow rule is acceptable. Never for Claude's
 * questions and plans, or for all Bash commands at once.
 */
function acceptableRule(rule: PermissionRuleValue): boolean {
  const tool = rule.toolName;
  if (
    tool === ASK_USER_QUESTION_TOOL ||
    tool === EXIT_PLAN_MODE_TOOL ||
    tool === ENTER_PLAN_MODE_TOOL
  ) {
    return false;
  }
  if (tool !== 'Bash') {
    return true;
  }
  const content = rule.ruleContent?.trim();
  return !!content && content !== '*';
}

/**
 * What "Allow for this session" may offer for a request, from Claude Code's
 * suggestions: allow rules and directories, applied to the session only
 * (never to settings files). Never a permission mode switch (`setMode`
 * suggestions are dropped): the user changes the mode only through the
 * mode control (and by approving a plan). `null` when nothing sound
 * remains, and always for questions and plans. `offer.mode` is always
 * `null`.
 */
export function sessionAllowOffer(
  request: Pick<
    ToolApprovalRequest,
    'toolName' | 'suggestions' | 'suppressAlwaysAllow'
  >,
): { offer: SessionAllowOffer; updates: PermissionUpdate[] } | null {
  if (
    request.suppressAlwaysAllow ||
    requestKind(request.toolName) !== 'tool' ||
    request.toolName === ENTER_PLAN_MODE_TOOL
  ) {
    return null;
  }
  const updates: PermissionUpdate[] = [];
  const offer: SessionAllowOffer = { rules: [], directories: [], mode: null };
  for (const suggestion of request.suggestions) {
    if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') {
      const rules = suggestion.rules.filter(acceptableRule);
      if (rules.length > 0) {
        updates.push({ ...suggestion, rules, destination: 'session' });
        offer.rules.push(...rules.map(ruleString));
      }
    } else if (suggestion.type === 'addDirectories') {
      updates.push({ ...suggestion, destination: 'session' });
      offer.directories.push(...suggestion.directories);
    }
  }
  return updates.length > 0 ? { offer, updates } : null;
}

/** The `permission.request` event of a request. */
export function describeRequest(
  requestId: string,
  request: ToolApprovalRequest,
  offer: SessionAllowOffer | null,
): PermissionRequestInput {
  const kind = requestKind(request.toolName);
  return {
    type: 'permission.request',
    requestId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    input: request.input,
    kind,
    title: request.title,
    description: request.description,
    displayName: request.displayName,
    decisionReason: request.decisionReason,
    blockedPath: request.blockedPath,
    agentId: request.agentId,
    gitPushes: request.gitPushes,
    pullRequest: request.pullRequest,
    repositoryAddition: request.repositoryAddition ?? null,
    reviewThreadReply: request.reviewThreadReply ?? null,
    pullRequestMerge: request.pullRequestMerge ?? null,
    pullRequestAutomation: request.pullRequestAutomation ?? null,
    sessionAllow: offer,
    questions: kind === 'question' ? parseQuestions(request.input) : null,
    plan: kind === 'plan' ? planText(request.input) : null,
    diff: request.diff ?? null,
  };
}

function resolution(
  event: PermissionRequestInput,
  fields: Partial<PermissionResolvedInput> &
    Pick<PermissionResolvedInput, 'decision' | 'cause'>,
): PermissionResolvedInput {
  return {
    type: 'permission.resolved',
    requestId: event.requestId,
    toolUseId: event.toolUseId,
    scope: null,
    message: null,
    answers: null,
    mode: null,
    sessionAllow: null,
    ...fields,
  };
}

/** How a request ends when it is cancelled (the tool is not used). */
export function cancellation(
  event: PermissionRequestInput,
  cause: Exclude<PermissionResolutionCause, 'user'>,
): { result: PermissionResult; resolution: PermissionResolvedInput } {
  const why: Record<typeof cause, string> = {
    interrupted: 'the user stopped the turn',
    ended: 'the user ended the session',
    process_exit: 'Claude Code ended',
    restart: 'the server stopped',
  };
  return {
    result: {
      behavior: 'deny',
      message: `The request was cancelled because ${why[cause]}; the tool was not used.`,
    },
    resolution: resolution(event, { decision: 'deny', cause }),
  };
}

/** Validates the answers to the questions of a request. */
function requireAnswers(
  raw: unknown,
  questions: UserQuestion[] | null,
): Record<string, string> {
  const object = requireObject(raw, 'answers');
  const known = new Set((questions ?? []).map((item) => item.question));
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(object)) {
    if (!known.has(question)) {
      throw new BadRequestException(`Unknown question: ${question}`);
    }
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new BadRequestException(
        `The answer to "${question}" must be a non-empty string`,
      );
    }
    if (answer.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(
        `The answer to "${question}" is longer than ${MAX_MESSAGE_LENGTH} characters`,
      );
    }
    answers[question] = answer.trim();
  }
  for (const question of known) {
    if (!(question in answers)) {
      throw new BadRequestException(`Answer every question: ${question}`);
    }
  }
  return answers;
}

/**
 * Turns the user's answer into Claude Code's permission result and the
 * `permission.resolved` event. Throws BadRequestException for answers that
 * do not fit the request (e.g. "allow for this session" where it was not
 * offered, missing answers to questions).
 */
export function resolveResponse(
  event: PermissionRequestInput,
  input: Record<string, unknown>,
  updates: PermissionUpdate[],
  raw: unknown,
): { result: PermissionResult; resolution: PermissionResolvedInput } {
  const body = requireObject(raw);
  const decision = optionalEnum(body, 'decision', ['allow', 'deny'] as const);
  if (!decision) {
    throw new BadRequestException('decision must be one of allow, deny');
  }
  const message =
    optionalString(body, 'message', {
      maxLength: MAX_MESSAGE_LENGTH,
    })?.trim() || null;
  const scope = optionalEnum(body, 'scope', ['once', 'session'] as const);
  const mode = optionalEnum(body, 'mode', PLAN_MODES);
  if (scope === 'session' && (event.kind !== 'tool' || !event.sessionAllow)) {
    throw new BadRequestException(
      'This request can only be allowed once, not for the whole session',
    );
  }
  if (decision === 'deny') {
    let text: string;
    switch (event.kind) {
      case 'question':
        text = message
          ? `The user did not pick answers and replied: ${message}`
          : "The user declined to answer. Stop here and wait for the user's next message.";
        break;
      case 'plan':
        text = message
          ? `The user did not approve the plan and wants to keep planning. Their feedback: ${message}`
          : "The user did not approve the plan and wants to keep planning. Stop here and wait for the user's next message.";
        break;
      default:
        text = message
          ? `The user denied this tool use (it was not run) and said: ${message}`
          : DENIED_STOP_MESSAGE;
    }
    return {
      result: {
        behavior: 'deny',
        message: text,
        ...(message ? {} : { interrupt: true }),
      },
      resolution: resolution(event, { decision, cause: 'user', message }),
    };
  }
  switch (event.kind) {
    case 'question': {
      const answers = requireAnswers(body['answers'], event.questions);
      return {
        result: { behavior: 'allow', updatedInput: { ...input, answers } },
        resolution: resolution(event, {
          decision,
          cause: 'user',
          scope: 'once',
          answers,
        }),
      };
    }
    case 'plan': {
      const target = mode ?? 'default';
      return {
        result: {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [
            { type: 'setMode', mode: target, destination: 'session' },
          ],
        },
        resolution: resolution(event, {
          decision,
          cause: 'user',
          scope: 'once',
          mode: target,
        }),
      };
    }
    default: {
      const session = scope === 'session';
      return {
        result: {
          behavior: 'allow',
          updatedInput: input,
          ...(session ? { updatedPermissions: updates } : {}),
        },
        resolution: resolution(event, {
          decision,
          cause: 'user',
          scope: session ? 'session' : 'once',
          mode: session ? (event.sessionAllow?.mode ?? null) : null,
          sessionAllow: session ? event.sessionAllow : null,
        }),
      };
    }
  }
}

/**
 * What the user allowed for the whole session so far (from the stored
 * `permission.resolved` events), to give a new Claude Code process of the
 * session the same rules (`allowedTools`) and directories. The mode is
 * part of the session record already.
 */
export function sessionAllows(stored: StoredEvent[]): {
  rules: string[];
  directories: string[];
} {
  const rules = new Set<string>();
  const directories = new Set<string>();
  for (const { event } of stored) {
    if (
      event.type === 'permission.resolved' &&
      event.scope === 'session' &&
      event.sessionAllow
    ) {
      for (const rule of event.sessionAllow.rules) {
        rules.add(rule);
      }
      for (const directory of event.sessionAllow.directories) {
        directories.add(directory);
      }
    }
  }
  return { rules: [...rules], directories: [...directories] };
}

/** Requests in the stored events that were never resolved. */
export function unresolvedRequests(
  stored: StoredEvent[],
): PermissionRequestInput[] {
  const open = new Map<string, PermissionRequestInput>();
  for (const { event } of stored) {
    if (event.type === 'permission.request') {
      open.set(event.requestId, event);
    } else if (event.type === 'permission.resolved') {
      open.delete(event.requestId);
    }
  }
  return [...open.values()];
}
