/**
 * The parts of Codex's app-server protocol the adapter uses, written after
 * the types `codex app-server generate-ts --experimental` produces for the
 * pinned version (see `CODEX_VERSION`). Fields the adapter does not read are
 * left out; unknown variants are tolerated.
 */

/** The Codex version the adapter is written against. */
export const CODEX_VERSION = '0.171.0';

export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface CodexThread {
  id: string;
  model: string | null;
  path: string | null;
  cwd?: string | null;
}

export interface CodexThreadStartResponse {
  thread: CodexThread;
  model: string;
}

export interface CodexUserInputText {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

export type CodexUserInput =
  | CodexUserInputText
  | { type: 'localImage'; path: string }
  | { type: string; [key: string]: unknown };

export interface CodexFileUpdateChange {
  path: string;
  kind:
    | { type: 'add' }
    | { type: 'delete' }
    | { type: 'update'; move_path: string | null };
  diff: string;
}

export type CodexThreadItem =
  | {
      type: 'userMessage';
      id: string;
      clientId: string | null;
      content: CodexUserInput[];
    }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'plan'; id: string; text: string }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      /** Codex's parsed actions of the command (for display). */
      commandActions?: { type: string; command?: string }[] | null;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: CodexFileUpdateChange[];
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      result: { content: unknown[] } | null;
      error: { message: string } | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      namespace: string | null;
      tool: string;
      arguments: unknown;
      contentItems:
        | ({ type: 'inputText'; text: string } | { type: string })[]
        | null;
      success: boolean | null;
    }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'imageView'; id: string; path: string }
  | { type: 'contextCompaction'; id: string }
  | { type: string; id: string };

export interface CodexTurnError {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: CodexTurnError | null;
  durationMs: number | null;
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  rateLimitReachedType: unknown;
}

export interface CodexAccountResponse {
  account:
    | {
        type: 'chatgpt';
        email: string | null;
        planType: string;
        workspaceName: string | null;
      }
    | { type: string }
    | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault?: boolean;
  /** The reasoning efforts the model offers (any string to Codex). */
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
}

/** Whether an error is the account's usage limit (`usageLimitExceeded`). */
export function isUsageLimit(info: unknown): boolean {
  return info === 'usageLimitExceeded';
}
