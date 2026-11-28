import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionPermissionMode } from '@claude-remote-manager/shared-types';
import type { ProcessLauncher } from '../../common/process-isolation';
import type {
  AgentAccount,
  AgentProbe,
  AgentReviewOptions,
  AgentReviewResult,
  AgentRun,
  AgentRunner,
  AgentStartOptions,
  AgentTool,
  AgentUserMessage,
} from '../agent-runner';
import type {
  AgentApprovalResult,
  AgentEvent,
  AgentHistoryEntry,
} from '../agent-events';
import { AsyncQueue } from '../async-queue';
import { loadZod } from '../sdk-agent-runner';
import type { TranscriptReader } from '../transcript-reader';
import {
  runAccountHelper,
  runAccountHelperJson,
} from '../../accounts/claude-account-directories';
import { CODEX_ACCOUNT_DIR_SCRIPT } from '../../accounts/codex-accounts';
import { CodexAppServer } from './codex-app-server';
import {
  CODEX_APP_INPUT_PREFIX,
  CODEX_APP_TOOL_NAMESPACE,
  CodexEventTranslator,
  codexContextUsage,
  codexHistory,
  codexModel,
  codexPlanUsage,
  codexToolName,
  shellScript,
} from './codex-events';
import type {
  CodexApprovalPolicy,
  CodexFileUpdateChange,
  CodexModel,
  CodexRateLimitSnapshot,
  CodexThreadItem,
  CodexThreadStartResponse,
  CodexTurn,
  CodexUserInput,
} from './codex-protocol';

/** Codex's approval policy for a session's mode (its own modes). */
export function codexPolicy(mode: SessionPermissionMode): CodexApprovalPolicy {
  return mode === 'on-request' || mode === 'never' ? mode : 'untrusted';
}

/**
 * Configuration every thread gets: Codex reads a repository's `CLAUDE.md`
 * where it has no `AGENTS.md` (project instructions written for Claude
 * Code apply to Codex sessions of the repository too).
 */
export const CODEX_THREAD_CONFIG = {
  project_doc_fallback_filenames: ['CLAUDE.md'],
};

/** The text and image inputs of a message: only what the user wrote. */
export function codexInput(message: AgentUserMessage): CodexUserInput[] {
  return [
    ...(message.images ?? []).map(
      (image): CodexUserInput => ({
        type: 'image',
        url: `data:${image.mediaType};base64,${image.data}`,
      }),
    ),
    ...(message.text
      ? [{ type: 'text', text: message.text, text_elements: [] }]
      : []),
  ] as CodexUserInput[];
}

/** One fragment of a turn's `additionalContext`. */
export interface CodexContextEntry {
  kind: 'untrusted' | 'application';
  value: string;
  /** Labels untrusted content (`[a-z][a-z0-9_]{0,63}`). */
  name?: string;
}

/**
 * A message's context and note as Codex's additional context of the turn,
 * not as input: the untrusted context (GitHub content) as `untrusted`
 * (Codex hands it to the model as a tool output, not as the user's
 * words), the app's note as `application` (a developer message). Neither
 * is a user message of the thread, so the history shows only what the
 * user typed. `undefined`: none.
 */
export function codexAdditionalContext(
  message: AgentUserMessage,
): Record<string, CodexContextEntry> | undefined {
  const entries: Record<string, CodexContextEntry> = {};
  if (message.context) {
    entries['crm_context'] = {
      kind: 'untrusted',
      value: message.context.text,
      name: 'github',
    };
  }
  if (message.note) {
    entries['crm_note'] = { kind: 'application', value: message.note.text };
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

/** Shell syntax that makes a command more than one simple command. */
const COMPOUND = /[;&|<>`$()\n\\]/;

/**
 * Whether a command is allowed by one of the session's Bash rules (as
 * "Allow for this session" stores them, in Claude Code's syntax):
 * `Bash(<command>)` exactly, `Bash(<prefix>:*)` for the command and its
 * arguments, `Bash(<pattern with *>)` as a wildcard. Prefixes and
 * wildcards only match a single simple command (no operators, expansions
 * or redirections), so an allowed `git status:*` does not allow
 * `git status; rm -rf ~`.
 */
export function matchesBashRule(
  command: string,
  rules: readonly string[],
): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  for (const rule of rules) {
    const match = /^Bash\((.+)\)$/s.exec(rule);
    if (!match) {
      continue;
    }
    const content = match[1].trim();
    if (!content || content === '*' || content === ':*') {
      continue;
    }
    if (content === trimmed) {
      return true;
    }
    if (COMPOUND.test(trimmed)) {
      continue;
    }
    if (content.endsWith(':*')) {
      const prefix = content.slice(0, -2).trim();
      if (prefix && (trimmed === prefix || trimmed.startsWith(`${prefix} `))) {
        return true;
      }
    } else if (content.includes('*')) {
      const parts = content
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (new RegExp(`^${parts.join('.*')}$`, 's').test(trimmed)) {
        return true;
      }
    }
  }
  return false;
}

/** Found rollouts by home and thread (a thread keeps its file). */
const rollouts = new Map<string, string>();

/** Forgets the found rollouts of a thread (in every home). */
function forgetRollouts(threadId: string): void {
  for (const key of [...rollouts.keys()]) {
    if (key.endsWith(`\0${threadId}`)) {
      rollouts.delete(key);
    }
  }
}

/**
 * The rollout file of a thread under a Codex home's `sessions/`, else its
 * `archived_sessions/` (both shared by
 * all accounts): Codex resumes a thread of another account by its path.
 * A found path is remembered until the file is gone (e.g. compressed).
 */
export async function findRollout(
  home: string,
  threadId: string,
): Promise<string | null> {
  const key = `${home}\0${threadId}`;
  const known = rollouts.get(key);
  if (known) {
    try {
      await access(known);
      return known;
    } catch {
      rollouts.delete(key);
    }
  }
  const found = await scanRollouts(home, threadId);
  if (found) {
    rollouts.set(key, found);
  }
  return found;
}

async function scanRollouts(
  home: string,
  threadId: string,
): Promise<string | null> {
  const root = join(home, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const visit = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Newest first: years, months and days sort by name.
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        const found = await visit(path, depth + 1);
        if (found) {
          return found;
        }
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        (entry.name.endsWith(suffix) || entry.name.endsWith(`${suffix}.zst`))
      ) {
        return path;
      }
    }
    return null;
  };
  return (
    (await visit(root, 0)) ?? (await visit(join(home, 'archived_sessions'), 0))
  );
}

/**
 * Configuration that keeps the user's MCP servers from starting, for a
 * process that only reads a thread: each configured server disabled by
 * name (Codex merges the overrides into its configuration).
 */
async function withoutMcpServers(
  server: CodexAppServer,
): Promise<Record<string, boolean>> {
  try {
    const answer = await server.request<{
      config?: { mcp_servers?: Record<string, unknown> | null };
    }>('config/read', {});
    return Object.fromEntries(
      Object.keys(answer.config?.mcp_servers ?? {}).map((name) => [
        `mcp_servers.${name}.enabled`,
        false,
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * Turns per thread: a history read and the start of a session's process
 * never have the same thread open in two homes at once (each waits for the
 * other's app server to have ended, or for the start to have resumed).
 */
export class ThreadGate {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tail = next.catch(() => undefined);
    this.tails.set(threadId, tail);
    void tail.then(() => {
      if (this.tails.get(threadId) === tail) {
        this.tails.delete(threadId);
      }
    });
    return next;
  }
}

/** Where the runner finds Codex. */
export interface CodexRunnerConfig {
  executable: string;
  /** The Codex home whose `sessions/` all accounts share (history reads). */
  baseHome: string;
  /**
   * The machine's rules for all sessions that Claude Code reads itself as
   * managed policy (`/etc/claude-code/CLAUDE.md` in the image); Codex gets
   * them first in its developer instructions (`CODEX_INSTRUCTIONS_FILE`).
   */
  instructionsFile?: string | null;
}

/**
 * Starts Codex processes (`codex app-server`) for sessions, one thread per
 * session, as the session user with the account's Codex home: the Codex
 * adapter of the engine-neutral core.
 */
@Injectable()
export class CodexRunner implements AgentRunner {
  /** Shared by the history reads and the sessions' process starts. */
  private readonly threads = new ThreadGate();
  constructor(
    private readonly config: CodexRunnerConfig,
    private readonly launcher: ProcessLauncher,
  ) {}

  async start(
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<AgentRun> {
    const start = () =>
      CodexProcess.start(this.config, this.launcher, options, firstMessage);
    // A resumed thread waits for a history read of it to end.
    return options.resume ? this.threads.run(options.resume, start) : start();
  }

  async probe<T>(
    task: (probe: AgentProbe) => Promise<T>,
    account?: AgentAccount,
  ): Promise<T> {
    const server = await CodexAppServer.start({
      executable: this.config.executable,
      launcher: this.launcher,
      home: account?.configDir ?? this.config.baseHome,
      cwd: tmpdir(),
    });
    try {
      return await task({
        supportedModels: async () =>
          (await listModels(server))
            .filter((model) => !model.hidden)
            .map(codexModel),
        supportedCommands: async () => [],
        planUsage: async () => readPlanUsage(server),
      });
    } finally {
      server.close();
    }
  }

  review(_options: AgentReviewOptions): Promise<AgentReviewResult> {
    return Promise.reject(
      new Error('Independent reviews do not run with Codex yet'),
    );
  }

  /**
   * Deletes a thread from a Codex home (its databases and rollout);
   * `false` when that home does not know it or Codex cannot start.
   */
  async deleteThread(home: string, threadId: string): Promise<boolean> {
    let server: CodexAppServer | null = null;
    try {
      server = await CodexAppServer.start({
        executable: this.config.executable,
        launcher: this.launcher,
        home,
        cwd: tmpdir(),
      });
      await server.request('thread/delete', { threadId });
      return true;
    } catch {
      return false;
    } finally {
      await server?.close();
    }
  }

  /**
   * Reads a thread's history (any account's, through the shared
   * rollouts). Codex knows a thread of another home only once it resumed
   * it by its path; the process runs in the temporary directory and the
   * thread keeps its own working directory (which may be gone: the
   * session's first directory, removed since), without the user's MCP
   * servers and without the turns in the resume's answer.
   */
  history(threadId: string): Promise<AgentHistoryEntry[]> {
    return this.threads.run(threadId, () => this.readHistory(threadId));
  }

  private async readHistory(threadId: string): Promise<AgentHistoryEntry[]> {
    const path = await findRollout(this.config.baseHome, threadId);
    if (!path) {
      return [];
    }
    const server = await CodexAppServer.start({
      executable: this.config.executable,
      launcher: this.launcher,
      home: this.config.baseHome,
      cwd: tmpdir(),
    });
    try {
      await server.request('thread/resume', {
        threadId,
        path,
        excludeTurns: true,
        config: {
          ...(await withoutMcpServers(server)),
          // No session hooks for a read (feature `hooks` of Codex 0.171).
          'features.hooks': false,
        },
      });
      const answer = await server.request<{
        thread: { turns?: CodexTurn[] };
      }>('thread/read', { threadId, includeTurns: true });
      return codexHistory(answer.thread.turns ?? []);
    } finally {
      // Ended before the session's own process may resume the thread.
      await server.close();
    }
  }
}

/** Codex's models, page by page (a cursor seen before ends it). */
async function listModels(server: CodexAppServer): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const answer: { data: CodexModel[]; nextCursor?: string | null } =
      await server.request('model/list', cursor ? { cursor } : {});
    models.push(...answer.data);
    cursor = answer.nextCursor ?? null;
    if (cursor !== null && seen.has(cursor)) {
      break;
    }
    if (cursor !== null) {
      seen.add(cursor);
    }
  } while (cursor !== null);
  return models;
}

/** The plan limits, the main bucket where Codex reports buckets. */
async function readPlanUsage(server: CodexAppServer) {
  const answer = await server.request<{
    rateLimits: CodexRateLimitSnapshot;
    rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
  }>('account/rateLimits/read', {});
  return codexPlanUsage(answer.rateLimits, answer.rateLimitsByLimitId);
}

/** Codex's history reader (see `TranscriptReader`). */
export class CodexTranscriptReader implements TranscriptReader {
  constructor(
    private readonly runner: CodexRunner,
    private readonly baseHome: string,
    private readonly launcher: ProcessLauncher,
  ) {}

  /**
   * Removes a deleted session's thread everywhere Codex keeps it: with
   * `thread/delete` in the base home and in every account's home (each
   * has the thread in its databases once it ran or read it; homes that do
   * not know it refuse, which is fine), then whatever rollout is left in
   * the shared `sessions/` and `archived_sessions/`, as the session user
   * who owns them (helper `codex-account-dir.cjs remove-thread`).
   */
  async remove(threadId: string): Promise<void> {
    const answer = await runAccountHelperJson(
      this.launcher,
      CODEX_ACCOUNT_DIR_SCRIPT,
      ['homes', this.baseHome],
    );
    const homes = Array.isArray(answer['homes'])
      ? answer['homes'].filter(
          (home): home is string => typeof home === 'string',
        )
      : [];
    for (const home of [...homes, this.baseHome]) {
      await this.runner.deleteThread(home, threadId);
    }
    await runAccountHelper(this.launcher, CODEX_ACCOUNT_DIR_SCRIPT, [
      'remove-thread',
      this.baseHome,
      threadId,
    ]);
    forgetRollouts(threadId);
  }

  read(threadId: string): Promise<AgentHistoryEntry[]> {
    return this.runner.history(threadId);
  }

  async exists(threadId: string): Promise<boolean> {
    return (await findRollout(this.baseHome, threadId)) !== null;
  }

  async stamp(threadId: string): Promise<string | null> {
    const path = await findRollout(this.baseHome, threadId);
    if (!path) {
      return null;
    }
    const info = await stat(path);
    return `${info.size}@${info.mtimeMs}`;
  }
}

/** The ID prefix of the question Codex asks to approve an MCP tool call. */
export const MCP_APPROVAL_QUESTION_PREFIX = 'mcp_tool_call_approval';
/** `_meta.codex_approval_kind` of an elicitation that approves an MCP tool. */
export const MCP_APPROVAL_KIND = 'mcp_tool_call';

/** A question of `item/tool/requestUserInput`. */
interface CodexQuestion {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[] | null;
}

/**
 * The option of an MCP tool approval question that allows the call once
 * (`allowed`) or cancels it. Codex's options (0.171): "Run the tool and
 * continue.", "… remember this choice for this session.", "… for future
 * tool calls.", "Cancel this tool call." (their descriptions; the labels
 * are matched too). Never one that makes Codex remember the choice: the
 * app keeps "allow for this session" itself.
 */
export function approvalOption(
  options: readonly { label: string; description?: string }[],
  allowed: boolean,
): string | null {
  const text = (option: { label: string; description?: string }) =>
    `${option.label} ${option.description ?? ''}`.toLowerCase();
  const cancels = (option: { label: string; description?: string }) =>
    /cancel|decline|deny|reject/.test(text(option));
  const remembers = (option: { label: string; description?: string }) =>
    /remember|session|always|don't ask|future/.test(text(option));
  const chosen = allowed
    ? options.find((option) => !cancels(option) && !remembers(option))
    : options.find(cancels);
  return chosen?.label ?? null;
}

/** A running call of one of the user's MCP tools. */
interface McpCall {
  itemId: string | null;
  threadId: string | null;
  server: string;
  tool: string;
  arguments: unknown;
}

/** Whether two JSON values are equal (key order aside). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((value, i) => sameJson(value, b[i]))
    );
  }
  const left = Object.keys(a as object);
  const right = Object.keys(b as object);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        sameJson(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

/** What every approval call of a request shares. */
type ApprovalBase = {
  title: string | null;
  displayName: string | null;
  decisionReason: string | null;
  blockedPath: string | null;
  agentId: string | null;
  suppressAlwaysAllow: boolean;
  signal: AbortSignal;
};

/** Input of the app's own sent into a running turn (see `steer`). */
const APP_INPUT_TEXT =
  '[Message from the session manager, not from the user: see its note.]';

/** One running Codex process with its thread. */
class CodexProcess implements AgentRun {
  private readonly logger = new Logger('CodexProcess');
  private readonly queue = new AsyncQueue<AgentEvent[]>();
  private readonly pending: AgentUserMessage[] = [];
  /** The changes of running `fileChange` items (for their approval). */
  private readonly fileChanges = new Map<string, CodexFileUpdateChange[]>();
  /** Open server requests by JSON-RPC ID: aborted once Codex resolves one. */
  private readonly openRequests = new Map<number | string, AbortController>();
  /**
   * Rules the user allowed for this session, each for exactly one call:
   * `Bash(<command>)` for that command, `Edit(<path>)` for changes of that
   * file, a tool name (`mcp__<server>__<tool>`) for that tool. Never read
   * as prefixes or wildcards (a command may contain `*` itself).
   */
  private readonly sessionRules: Set<string>;
  /**
   * Bash rules configured for the session's processes (not from "Allow for
   * this session"): these may be prefixes or wildcards.
   */
  private readonly patternRules: string[];
  /** Running MCP tool calls by item ID (for their approval). */
  private readonly mcpCalls = new Map<string, McpCall>();
  /**
   * The model Codex reported as its default when the thread started
   * without one; sent again after `setModel(null)` (`defaultInUse`).
   */
  private defaultModel: string | null = null;
  private defaultInUse = false;
  /**
   * What the app tells Codex with the next turn, when it could not tell
   * the turn it belonged to (it had ended).
   */
  private readonly appNotes: string[] = [];
  /** Notifications that came before the thread was known. */
  private readonly early: [string, unknown][] = [];
  private server!: CodexAppServer;
  private translator!: CodexEventTranslator;
  private threadId = '';
  /** The running turn's ID, `starting` until Codex named it. */
  private turnId: string | null = null;
  /** Counts turn/start requests: only the latest one's answer counts. */
  private turnStarts = 0;
  /** An interrupt asked for before the turn had its ID. */
  private interruptWanted = false;
  private model: string | null;
  private policy: CodexApprovalPolicy;
  private closed = false;

  private constructor(
    private readonly config: CodexRunnerConfig,
    private readonly launcher: ProcessLauncher,
    private readonly options: AgentStartOptions,
  ) {
    this.model = options.model;
    this.policy = codexPolicy(options.permissionMode);
    this.sessionRules = new Set(options.sessionAllows ?? []);
    this.patternRules = (options.allowedTools ?? []).filter(
      (rule) => rule.startsWith('Bash(') && !this.sessionRules.has(rule),
    );
  }

  static async start(
    config: CodexRunnerConfig,
    launcher: ProcessLauncher,
    options: AgentStartOptions,
    firstMessage: AgentUserMessage,
  ): Promise<CodexProcess> {
    const run = new CodexProcess(config, launcher, options);
    try {
      await run.open();
    } catch (error) {
      // The app server may run already (e.g. a refused thread/resume).
      run.close();
      throw error;
    }
    run.send(firstMessage);
    return run;
  }

  /** Passes events on, unless the process was closed meanwhile. */
  private emit(events: AgentEvent[]): void {
    if (!this.queue.isClosed) {
      this.queue.push(events);
    }
  }

  get events(): AsyncIterable<AgentEvent[]> {
    return this.queue;
  }

  private async open(): Promise<void> {
    const home = this.options.account?.configDir ?? this.config.baseHome;
    this.server = await CodexAppServer.start({
      executable: this.config.executable,
      launcher: this.launcher,
      home,
      env: this.options.env,
      cwd: this.options.cwd,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params, id) => this.serverRequest(method, params, id),
      onExit: (error) => {
        // Nobody answers them any more: their cards close.
        for (const controller of this.openRequests.values()) {
          controller.abort();
        }
        if (error && !this.closed) {
          this.queue.fail(error);
        } else {
          this.queue.close();
        }
      },
    });
    const developerInstructions = [
      await machineInstructions(this.config.instructionsFile ?? null),
      this.options.instructions ?? null,
    ]
      .filter((part): part is string => !!part)
      .join('\n\n');
    const common = {
      cwd: this.options.cwd,
      // Full access, as Claude Code has; asking is the approval policy's.
      sandbox: 'danger-full-access',
      approvalPolicy: this.policy,
      // Approvals come to the user (the app), never to a reviewer agent.
      approvalsReviewer: 'user',
      config: CODEX_THREAD_CONFIG,
      ...(this.model ? { model: this.model } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };
    let started: CodexThreadStartResponse;
    if (this.options.resume) {
      // The thread keeps the tools it started with: Codex takes dynamic
      // tools only at thread/start (the app gives every thread all of its
      // tools, see `AgentEngine.fixedTools`).
      const path = await findRollout(home, this.options.resume);
      started = await this.server.request<CodexThreadStartResponse>(
        'thread/resume',
        {
          ...common,
          threadId: this.options.resume,
          ...(path ? { path } : {}),
        },
      );
    } else {
      started = await this.server.request<CodexThreadStartResponse>(
        'thread/start',
        { ...common, dynamicTools: await dynamicTools(this.options.tools) },
      );
    }
    this.threadId = started.thread.id;
    if (!this.model && !this.options.resume) {
      this.defaultModel = started.model ?? null;
    }
    this.translator = new CodexEventTranslator(
      this.threadId,
      started.model ?? started.thread.model ?? 'codex',
      this.options.usageBaseline ?? {},
    );
    this.emit([
      {
        type: 'started',
        engineSessionId: this.threadId,
        permissionMode: null,
        terminalCommands: [],
      },
    ]);
    for (const [method, params] of this.early.splice(0)) {
      this.notification(method, params);
    }
  }

  send(message: AgentUserMessage): void {
    if (this.turnId !== null) {
      // Codex runs one turn at a time: queued until the turn ends.
      this.pending.push(message);
      return;
    }
    this.startTurn(message);
  }

  private startTurn(message: AgentUserMessage): void {
    const start = ++this.turnStarts;
    this.turnId = 'starting';
    this.interruptWanted = false;
    const context = {
      ...(codexAdditionalContext(message) ?? {}),
      ...this.takeAppNotes(),
    };
    this.server
      .request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId,
        clientUserMessageId: message.id,
        input: codexInput(message),
        ...(Object.keys(context).length > 0
          ? { additionalContext: context }
          : {}),
        approvalPolicy: this.policy,
        approvalsReviewer: 'user',
        ...(this.turnModel() ? { model: this.turnModel() } : {}),
      })
      .then((answer) => {
        // Only this request's turn, if no notification named it already
        // (or ended it, and a newer turn is starting).
        if (start === this.turnStarts && this.turnId === 'starting') {
          this.turnKnown(answer.turn.id);
        }
      })
      .catch((error: unknown) => {
        if (start !== this.turnStarts) {
          return;
        }
        this.turnId = null;
        this.interruptWanted = false;
        // One error: the result's text is shown as the turn's error.
        this.emit([
          this.failedResult(
            `Codex did not start the turn: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ]);
        // Messages queued behind it are not left waiting.
        const next = this.pending.shift();
        if (next && this.server.running) {
          this.startTurn(next);
        }
      });
  }

  /** The running turn has its ID: an interrupt asked for meanwhile is sent. */
  private turnKnown(turnId: string): void {
    this.turnId = turnId;
    if (this.interruptWanted) {
      this.interruptWanted = false;
      void this.sendInterrupt(turnId);
    }
  }

  private failedResult(text: string): AgentEvent {
    return {
      type: 'result',
      subtype: 'success',
      isError: true,
      text,
      errors: [],
      durationMs: 0,
      numTurns: 1,
      usage: {},
      engineSessionId: this.threadId,
      queuedTurns: this.pending.length,
    };
  }

  private notification(method: string, params: unknown): void {
    if (!this.translator) {
      // Before the thread is known (e.g. the usage Codex restores right
      // after `thread/resume`, in the same chunk as its answer): kept.
      this.early.push([method, params]);
      return;
    }
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'serverRequest/resolved') {
      // Codex settled a request itself (e.g. the turn ended): the app
      // stops waiting for the user.
      const id = p['requestId'];
      if (typeof id === 'number' || typeof id === 'string') {
        this.openRequests.get(id)?.abort();
      }
      return;
    }
    // Also a subagent's: its approvals come to the app too.
    const item = p['item'] as CodexThreadItem | undefined;
    if (method === 'item/started' && item?.type === 'fileChange') {
      // Kept for the approval of the change.
      this.fileChanges.set(
        item.id,
        (item as { changes: CodexFileUpdateChange[] }).changes,
      );
    }
    if (method === 'item/started' && item?.type === 'mcpToolCall') {
      const call = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>;
      this.mcpCalls.set(item.id, {
        itemId: item.id,
        threadId: typeof p['threadId'] === 'string' ? p['threadId'] : null,
        server: call.server,
        tool: call.tool,
        arguments: call.arguments,
      });
    }
    if (method === 'item/completed' && item) {
      this.fileChanges.delete(item.id);
      this.mcpCalls.delete(item.id);
    }
    const threadId = p['threadId'];
    if (typeof threadId === 'string' && threadId !== this.threadId) {
      // Another thread's (a subagent's) turns are not this thread's: they
      // must not end the running turn or start a queued message.
      return;
    }
    if (method === 'turn/started') {
      this.turnKnown((p['turn'] as { id: string }).id);
    }
    const events = this.translator.translate(method, params);
    if (method === 'turn/completed') {
      this.turnId = null;
      this.interruptWanted = false;
      const next = this.pending.shift();
      for (const event of events) {
        if (event.type === 'result') {
          event.queuedTurns = this.pending.length + (next ? 1 : 0);
        }
      }
      if (events.length > 0) {
        this.emit(events);
      }
      if (next) {
        this.startTurn(next);
      }
      return;
    }
    if (events.length > 0) {
      this.emit(events);
    }
  }

  private async serverRequest(
    method: string,
    params: unknown,
    id: number | string,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.openRequests.set(id, controller);
    try {
      return await this.answerRequest(
        method,
        (params ?? {}) as Record<string, unknown>,
        controller.signal,
      );
    } finally {
      this.openRequests.delete(id);
    }
  }

  private async answerRequest(
    method: string,
    p: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const base = {
      title: null,
      displayName: null,
      decisionReason: null,
      blockedPath: null,
      agentId: null,
      suppressAlwaysAllow: false,
      signal,
    };
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.commandApproval(p, base);
      case 'item/fileChange/requestApproval':
        return this.fileChangeApproval(p, base);
      case 'item/tool/call':
        return this.appTool(p, signal);
      // Requests the app cannot put to the user: answered so that the turn
      // goes on without them, never left waiting.
      case 'item/tool/requestUserInput':
        return this.userInput(p, base);
      case 'mcpServer/elicitation/request':
        return this.elicitation(p, base);
      case 'item/permissions/requestApproval':
        // Full access already: nothing more to grant.
        this.logger.warn(
          `Codex asked for further permissions (${method}); none granted`,
        );
        return { permissions: {}, scope: 'turn' };
      case 'applyPatchApproval':
      case 'execCommandApproval':
        // Requests of Codex's older API, not used with threads.
        this.logger.warn(`Codex sent ${method}; denied`);
        return {
          decision: { denied: { rejection: 'Not supported by this app.' } },
        };
      default:
        this.logger.warn(
          `Codex sent ${method}, which this app does not handle`,
        );
        throw new Error(`${method} is not supported by this app`);
    }
  }

  /** Rules the user just allowed for the session count from now on. */
  private rememberRules(result: AgentApprovalResult): void {
    if (result.behavior !== 'allow') {
      return;
    }
    for (const update of result.updatedPermissions ?? []) {
      if (update.type === 'addRules' && update.behavior === 'allow') {
        for (const rule of update.rules) {
          this.sessionRules.add(
            rule.ruleContent === undefined
              ? rule.toolName
              : `${rule.toolName}(${rule.ruleContent})`,
          );
        }
      }
    }
  }

  /** "Allow for this session" for exactly this rule. */
  private sessionSuggestion(toolName: string, ruleContent?: string) {
    return [
      {
        type: 'addRules' as const,
        rules: [
          ruleContent === undefined ? { toolName } : { toolName, ruleContent },
        ],
        behavior: 'allow' as const,
        destination: 'session',
      },
    ];
  }

  private async commandApproval(
    p: Record<string, unknown>,
    base: ApprovalBase,
  ): Promise<unknown> {
    const raw = typeof p['command'] === 'string' ? p['command'] : '';
    const kind = typeof p['kind'] === 'string' ? p['kind'] : 'command';
    const cwd = p['cwd'] ?? this.options.cwd;
    const reason = typeof p['reason'] === 'string' ? p['reason'] : null;
    const toolUseId = String(p['itemId'] ?? '');
    if (kind !== 'command') {
      // Input for a running command, or a command run on the user's
      // behalf: always asked, never allowed for the session.
      const result = await this.options.approve({
        ...base,
        title:
          kind === 'writeStdin'
            ? 'Codex wants to send input to a running command'
            : 'Codex wants to run a command on your behalf',
        toolName: 'Bash',
        input:
          kind === 'writeStdin'
            ? {
                command: `(input to a running command)\n${raw}`,
                stdin: raw,
                cwd,
              }
            : { command: raw, cwd },
        toolUseId,
        description: reason,
        mcpServer: null,
        suggestions: [],
        suppressAlwaysAllow: true,
      });
      if (result.behavior === 'deny') {
        return { decision: result.interrupt ? 'cancel' : 'decline' };
      }
      return { decision: 'accept' };
    }
    const actions = Array.isArray(p['commandActions'])
      ? (p['commandActions'] as { command?: unknown }[])
      : null;
    // What the model wrote, not the shell Codex wraps it in.
    const { script: command, exact } = shellScript(raw, actions);
    if (
      exact &&
      command &&
      (this.sessionRules.has(`Bash(${command})`) ||
        matchesBashRule(command, this.patternRules))
    ) {
      // Allowed for the session earlier (also by an earlier process).
      return { decision: 'accept' };
    }
    const result = await this.options.approve({
      ...base,
      toolName: 'Bash',
      input: { command, cwd },
      toolUseId,
      description: exact
        ? reason
        : [reason, `Codex runs exactly: ${raw}`].filter(Boolean).join('\n\n'),
      mcpServer: null,
      // "Allow for this session" means Codex's own `acceptForSession`, and
      // exactly this command for later processes.
      suggestions:
        command && exact ? this.sessionSuggestion('Bash', command) : [],
    });
    if (result.behavior === 'deny') {
      return { decision: result.interrupt ? 'cancel' : 'decline' };
    }
    const updated = result.updatedInput?.['command'];
    if (
      result.ranByApp ||
      (typeof updated === 'string' && updated !== command)
    ) {
      // The app ran something itself instead (Autofix): Codex does not
      // run it and learns what came of it.
      this.tellOutcome(command, result.ranByApp ?? null);
      return { decision: 'decline' };
    }
    this.rememberRules(result);
    return {
      decision:
        (result.updatedPermissions?.length ?? 0) > 0
          ? 'acceptForSession'
          : 'accept',
    };
  }

  /**
   * A file change: "allow for this session" is Codex's `acceptForSession`
   * (it stops asking for changes of these files) and an exact `Edit(<path>)`
   * rule per file, so a later process does not ask for them either.
   */
  private async fileChangeApproval(
    p: Record<string, unknown>,
    base: ApprovalBase,
  ): Promise<unknown> {
    const itemId = String(p['itemId'] ?? '');
    const changes = this.fileChanges.get(itemId) ?? [];
    const first = changes[0];
    const paths = [...new Set(changes.map((change) => change.path))];
    if (
      paths.length > 0 &&
      paths.every((path) => this.sessionRules.has(`Edit(${path})`))
    ) {
      return { decision: 'accept' };
    }
    const result = await this.options.approve({
      ...base,
      toolName: first?.kind.type === 'add' ? 'Write' : 'Edit',
      input: {
        file_path: first?.path ?? '',
        changes: changes.map((change) => ({
          path: change.path,
          kind: change.kind.type,
          diff: change.diff,
        })),
      },
      toolUseId: itemId,
      description: typeof p['reason'] === 'string' ? p['reason'] : null,
      mcpServer: null,
      suggestions:
        paths.length > 0
          ? [
              {
                type: 'addRules',
                rules: paths.map((path) => ({
                  toolName: 'Edit',
                  ruleContent: path,
                })),
                behavior: 'allow',
                destination: 'session',
              },
            ]
          : [],
    });
    if (result.behavior === 'deny') {
      return { decision: result.interrupt ? 'cancel' : 'decline' };
    }
    this.rememberRules(result);
    return {
      decision:
        (result.updatedPermissions?.length ?? 0) > 0
          ? 'acceptForSession'
          : 'accept',
    };
  }

  /**
   * Approval of a call of one of the user's MCP tools (Codex asks through
   * `requestUserInput` or an elicitation): an approval card for
   * `mcp__<server>__<tool>` with its arguments. "Allow for this session" is
   * kept by the app (an exact rule with the tool's name); Codex is always
   * answered "allow once" or "cancel". `true`: allowed.
   */
  private async mcpToolApproval(
    call: McpCall | null,
    message: string | null,
    base: ApprovalBase,
  ): Promise<boolean> {
    const itemId = call?.itemId ?? null;
    const toolName = call ? codexToolName(call.server, call.tool) : 'mcp__?';
    if (
      this.sessionRules.has(toolName) ||
      (this.options.allowedTools ?? []).includes(toolName)
    ) {
      return true;
    }
    const result = await this.options.approve({
      ...base,
      toolName,
      input:
        typeof call?.arguments === 'object' && call.arguments !== null
          ? (call.arguments as Record<string, unknown>)
          : {},
      toolUseId: itemId ?? '',
      description: message,
      mcpServer: call ? { name: call.server, source: 'codex' } : null,
      suggestions: call ? this.sessionSuggestion(toolName) : [],
    });
    if (result.behavior === 'deny') {
      return false;
    }
    this.rememberRules(result);
    return true;
  }

  /**
   * The running call an MCP approval elicitation is about: the one of its
   * server and thread with the tool and arguments in `_meta`
   * (`tool_name`, `tool_params`); when there is not exactly one, the call
   * as `_meta` describes it.
   */
  private elicitedCall(
    p: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): McpCall | null {
    const server = typeof p['serverName'] === 'string' ? p['serverName'] : null;
    const tool =
      typeof meta['tool_name'] === 'string' ? meta['tool_name'] : null;
    const threadId = typeof p['threadId'] === 'string' ? p['threadId'] : null;
    if (!server || !tool) {
      return null;
    }
    const params = meta['tool_params'] ?? {};
    const matches = [...this.mcpCalls.values()].filter(
      (call) =>
        call.server === server &&
        call.tool === tool &&
        (threadId === null ||
          call.threadId === null ||
          call.threadId === threadId) &&
        sameJson(call.arguments ?? {}, params),
    );
    return matches.length === 1
      ? matches[0]
      : { itemId: null, threadId, server, tool, arguments: params };
  }

  /**
   * `item/tool/requestUserInput`: an MCP tool approval (its question ID
   * starts with `mcp_tool_call_approval`), else questions of the model as
   * the app's question card (like Claude's `AskUserQuestion`).
   */
  private async userInput(
    p: Record<string, unknown>,
    base: ApprovalBase,
  ): Promise<unknown> {
    const questions = (
      Array.isArray(p['questions']) ? p['questions'] : []
    ) as CodexQuestion[];
    const itemId = typeof p['itemId'] === 'string' ? p['itemId'] : null;
    const approval = questions.find((question) =>
      question.id.startsWith(MCP_APPROVAL_QUESTION_PREFIX),
    );
    if (approval) {
      const allowed = await this.mcpToolApproval(
        (itemId ? this.mcpCalls.get(itemId) : undefined) ?? null,
        approval.question,
        base,
      );
      const label = approvalOption(approval.options ?? [], allowed);
      return {
        answers: label ? { [approval.id]: { answers: [label] } } : {},
      };
    }
    if (questions.length === 0) {
      return { answers: {} };
    }
    const result = await this.options.approve({
      ...base,
      toolName: 'AskUserQuestion',
      input: {
        questions: questions.map((question) => ({
          question: question.question,
          header: question.header ?? '',
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            description: option.description ?? '',
          })),
          multiSelect: false,
        })),
      },
      toolUseId: itemId ?? '',
      description: null,
      mcpServer: null,
      suggestions: [],
    });
    if (result.behavior === 'deny') {
      return { answers: {} };
    }
    const given = (result.updatedInput?.['answers'] ?? {}) as Record<
      string,
      unknown
    >;
    return {
      answers: Object.fromEntries(
        questions
          .filter((question) => typeof given[question.question] === 'string')
          .map((question) => [
            question.id,
            { answers: [given[question.question] as string] },
          ]),
      ),
    };
  }

  /**
   * An MCP elicitation: Codex's own MCP tool approvals
   * (`_meta.codex_approval_kind` `mcp_tool_call`) as an approval card;
   * other servers' requests for input are declined (logged).
   */
  private async elicitation(
    p: Record<string, unknown>,
    base: ApprovalBase,
  ): Promise<unknown> {
    const meta = (p['_meta'] ?? null) as Record<string, unknown> | null;
    if (meta?.['codex_approval_kind'] === MCP_APPROVAL_KIND) {
      const allowed = await this.mcpToolApproval(
        this.elicitedCall(p, meta),
        typeof p['message'] === 'string' ? p['message'] : null,
        base,
      );
      return allowed
        ? { action: 'accept', content: {}, _meta: null }
        : { action: 'decline', content: null, _meta: null };
    }
    this.logger.warn(
      `The MCP server ${String(p['serverName'] ?? '?')} asked for input; declined`,
    );
    return { action: 'decline', content: null, _meta: null };
  }

  /**
   * Tells the running turn what came of a command the app ran itself
   * instead of Codex (declined to Codex, which has no reason to give with
   * a decline): sent into the turn with `turn/steer` as a note of the app
   * (additional context) once the decline is answered; when the turn has
   * ended by then, with the next turn instead.
   */
  private tellOutcome(
    command: string,
    outcome: { ok: boolean; output: string } | null,
  ): void {
    const note = [
      `The session manager ran \`${command}\` itself instead of you (it runs git add, commit and push during Autofix), so it was declined to you; do not run it again.`,
      outcome
        ? `It ${outcome.ok ? 'succeeded' : 'failed'}. Output:\n${outcome.output}`
        : 'Its outcome is not known.',
    ].join('\n');
    setImmediate(() => {
      void this.steer(note);
    });
  }

  private async steer(note: string): Promise<void> {
    const turnId = this.turnId;
    if (!turnId || turnId === 'starting' || !this.server.running) {
      this.appNotes.push(note);
      return;
    }
    try {
      await this.server.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: turnId,
        clientUserMessageId: `${CODEX_APP_INPUT_PREFIX}${randomUUID()}`,
        input: [{ type: 'text', text: APP_INPUT_TEXT, text_elements: [] }],
        additionalContext: {
          crm_app_note: { kind: 'application', value: note },
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not tell Codex's turn what the app ran: ${String(error)}`,
      );
      this.appNotes.push(note);
    }
  }

  /** Notes the app could not send into their turn, for the next one. */
  private takeAppNotes(): Record<string, CodexContextEntry> {
    const notes = this.appNotes.splice(0);
    return notes.length > 0
      ? { crm_app_note: { kind: 'application', value: notes.join('\n\n') } }
      : {};
  }

  /** A call of one of the app's own tools (Codex's dynamic tools). */
  private async appTool(
    p: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const name = String(p['tool'] ?? '');
    const tool = this.options.tools?.find((entry) => entry.name === name);
    const fail = (text: string) => ({
      contentItems: [{ type: 'inputText', text }],
      success: false,
    });
    if (!tool) {
      return fail(
        `Unknown tool ${name}: this session manager does not offer it (any more).`,
      );
    }
    if (tool.unavailable) {
      // Registered for the thread, but not for this session now.
      return fail(tool.unavailable);
    }
    const input =
      typeof p['arguments'] === 'object' && p['arguments'] !== null
        ? (p['arguments'] as Record<string, unknown>)
        : {};
    const callId = String(p['callId'] ?? '');
    const fullName = codexToolName(CODEX_APP_TOOL_NAMESPACE, name);
    const gate = this.options.gate
      ? await this.options.gate({
          toolName: fullName,
          input,
          toolUseId: callId,
          agentId: null,
          mcpServer: { name: CODEX_APP_TOOL_NAMESPACE, source: 'sdk' },
        })
      : null;
    let approvedInput = input;
    if (gate?.decision === 'deny') {
      return fail(gate.reason);
    }
    const allowed =
      gate?.decision === 'allow' ||
      (gate?.decision !== 'ask' &&
        ((this.options.allowedTools ?? []).includes(fullName) ||
          this.sessionRules.has(fullName) ||
          // `never` asks for nothing, like Claude Code's bypass mode.
          this.policy === 'never'));
    if (!allowed) {
      const result = await this.options.approve({
        toolName: fullName,
        input,
        toolUseId: callId,
        title: null,
        description: gate?.reason ?? null,
        displayName: null,
        decisionReason: null,
        blockedPath: null,
        agentId: null,
        mcpServer: { name: CODEX_APP_TOOL_NAMESPACE, source: 'sdk' },
        // The tool by its name, as for Claude Code.
        suggestions: this.sessionSuggestion(fullName),
        suppressAlwaysAllow: false,
        signal,
      });
      if (result.behavior === 'deny') {
        return fail(result.message);
      }
      this.rememberRules(result);
      approvedInput = result.updatedInput ?? input;
    }
    try {
      const output = await tool.handler(approvedInput, { toolUseId: callId });
      return {
        contentItems: [{ type: 'inputText', text: output.text }],
        success: output.isError !== true,
      };
    } catch (error) {
      this.logger.warn(`App tool ${name} failed: ${String(error)}`);
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.turnId;
    if (!turnId) {
      return;
    }
    if (turnId === 'starting') {
      // Sent once Codex names the turn.
      this.interruptWanted = true;
      return;
    }
    await this.sendInterrupt(turnId);
  }

  private async sendInterrupt(turnId: string): Promise<void> {
    try {
      await this.server.request('turn/interrupt', {
        threadId: this.threadId,
        turnId,
      });
    } catch (error) {
      this.logger.warn(`Codex did not interrupt the turn: ${String(error)}`);
    }
  }

  async contextUsage() {
    const usage = this.translator.tokenUsage;
    const context = usage
      ? codexContextUsage(usage, this.translator.model)
      : null;
    if (!context) {
      throw new Error('Codex has not reported its context usage yet');
    }
    return context;
  }

  async planUsage() {
    return readPlanUsage(this.server);
  }

  async setPermissionMode(mode: SessionPermissionMode): Promise<void> {
    // From the next turn on.
    this.policy = codexPolicy(mode);
  }

  /**
   * `null` after an explicit model: Codex keeps a turn's model for the
   * next ones, so the default goes with each turn from then on (the model
   * Codex started the thread with, else the default of its model list).
   */
  async setModel(model: string | null): Promise<void> {
    this.model = model;
    this.defaultInUse = false;
    if (model) {
      this.translator.model = model;
      return;
    }
    const fallback = this.defaultModel ?? (await this.listedDefault());
    if (fallback) {
      this.defaultModel = fallback;
      this.defaultInUse = true;
      this.translator.model = fallback;
    }
  }

  /** The model a turn names (`null`: none, Codex's own choice). */
  private turnModel(): string | null {
    return this.model ?? (this.defaultInUse ? this.defaultModel : null);
  }

  private async listedDefault(): Promise<string | null> {
    try {
      const models = await listModels(this.server);
      return models.find((model) => model.isDefault)?.model ?? null;
    } catch (error) {
      this.logger.warn(
        `Could not read Codex's default model: ${String(error)}`,
      );
      return null;
    }
  }

  async supportedCommands() {
    return [];
  }

  async stopTask(): Promise<void> {
    // Codex has no background tasks the app can stop.
  }

  async addDirectories(): Promise<void> {
    // Full access: Codex can work in any directory already.
  }

  /** Resolves once Codex has ended (killed when it does not in time). */
  close(): Promise<void> {
    this.closed = true;
    for (const controller of this.openRequests.values()) {
      controller.abort();
    }
    const ended = this.server?.close() ?? Promise.resolve();
    this.queue.close();
    return ended;
  }

  stderrTail(): string[] {
    return this.server?.stderrTail() ?? [];
  }
}

/** The app's tools as Codex dynamic tools (JSON schema from Zod). */
async function dynamicTools(tools: AgentTool[] | undefined) {
  if (!tools || tools.length === 0) {
    return [];
  }
  const z = await loadZod();
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.object(tool.inputSchema(z))),
  }));
}

/** The machine's rules for sessions, read for every process; `null`: none. */
async function machineInstructions(
  file: string | null,
): Promise<string | null> {
  if (!file) {
    return null;
  }
  try {
    return (await readFile(file, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}
