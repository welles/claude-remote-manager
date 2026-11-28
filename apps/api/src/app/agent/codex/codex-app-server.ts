import { spawn, type ChildProcess } from 'node:child_process';
import type { ProcessLauncher } from '../../common/process-isolation';

/** How long a request may take before it fails (turns run longer). */
export const CODEX_REQUEST_TIMEOUT_MS = 60_000;
const STDERR_LINES = 8;

/** An error answer of the app server. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}

export interface CodexAppServerOptions {
  /** The `codex` executable. */
  executable: string;
  launcher: ProcessLauncher;
  /** The account's Codex home (`CODEX_HOME`). */
  home: string;
  /** Further environment (the session's variables). */
  env?: Record<string, string>;
  cwd: string;
  /** Notifications of the server (no answer). */
  onNotification?: (method: string, params: unknown) => void;
  /** Requests of the server (approvals, tool calls); the answer goes back. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** The process ended (`null`: on purpose). */
  onExit?: (error: Error | null) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * A `codex app-server` process of an account, spoken to with JSON-RPC
 * (one JSON object per line) over stdio, as OpenAI's IDE extension does.
 * Started as the session user, like Claude Code.
 */
export class CodexAppServer {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly stderr: string[] = [];
  private nextId = 1;
  private buffer = '';
  private closing = false;
  private ended = false;

  private constructor(private readonly options: CodexAppServerOptions) {
    const command = options.launcher.command('session', options.executable, [
      'app-server',
    ]);
    this.child = spawn(command.command, command.args, {
      cwd: options.cwd,
      env: options.launcher.environment('session', {
        ...(options.env ?? {}),
        CODEX_HOME: options.home,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) {
          this.stderr.push(line.trim());
        }
      }
      this.stderr.splice(0, Math.max(0, this.stderr.length - STDERR_LINES));
    });
    // Writing to a process that just ended must not crash the API.
    this.child.stdin?.on('error', () => undefined);
    this.child.on('error', (error) => this.end(error));
    this.child.on('close', (code, signal) =>
      this.end(
        this.closing
          ? null
          : new Error(
              [
                `Codex ended (${signal ?? `exit code ${code}`})`,
                ...this.stderr,
              ].join('\n'),
            ),
      ),
    );
  }

  /** Starts the app server and completes the handshake. */
  static async start(options: CodexAppServerOptions): Promise<CodexAppServer> {
    const server = new CodexAppServer(options);
    try {
      await server.request('initialize', {
        clientInfo: { name: 'claude-remote-manager', version: '1' },
        // Dynamic tools, thread paths and the like are experimental.
        capabilities: { experimentalApi: true },
      });
      server.notify('initialized', undefined);
    } catch (error) {
      server.close();
      throw error;
    }
    return server;
  }

  /** Sends a request and waits for its answer. */
  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number | null = CODEX_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.ended) {
      return Promise.reject(new Error('Codex is not running'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Codex did not answer ${method} in time`));
            }, timeoutMs);
      timer?.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  /** Ends the process. */
  close(): void {
    this.closing = true;
    this.child.stdin?.end();
    this.child.kill('SIGTERM');
  }

  get running(): boolean {
    return !this.ended;
  }

  /** The last lines Codex wrote to stderr, for error messages. */
  stderrTail(): string[] {
    return [...this.stderr];
  }

  private write(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    for (
      let newline = this.buffer.indexOf('\n');
      newline >= 0;
      newline = this.buffer.indexOf('\n')
    ) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.handle(line);
      }
    }
  }

  private handle(line: string): void {
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      void this.answer(message.id, message.method, message.params);
      return;
    }
    if (message.method !== undefined) {
      this.options.onNotification?.(message.method, message.params);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (message.error) {
        pending.reject(
          new CodexRpcError(
            message.error.code,
            message.error.message,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async answer(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      const result = this.options.onRequest
        ? await this.options.onRequest(method, params)
        : null;
      this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private end(error: Error | null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error ?? new Error('Codex was closed'));
    }
    this.pending.clear();
    this.options.onExit?.(error);
  }
}
