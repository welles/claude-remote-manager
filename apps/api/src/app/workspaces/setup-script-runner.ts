import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';

export interface SetupScriptOptions {
  script: string;
  /** The new worktree. */
  cwd: string;
  /** Added to the API's environment. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Aborting stops the script (e.g. the session was ended). */
  signal?: AbortSignal;
  /** Output (stdout and stderr interleaved) in chunks. */
  onOutput(text: string): void;
}

export interface SetupScriptResult {
  state: 'succeeded' | 'failed' | 'timed_out';
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Why the script could not run or was stopped. */
  message: string | null;
  /** Last lines of the output when it exceeded the limit. */
  outputTail: string | null;
}

/** Output beyond this is not forwarded; `outputTail` keeps the end. */
export const MAX_SETUP_OUTPUT = 256 * 1024;
const TAIL_LENGTH = 8 * 1024;
const FLUSH_INTERVAL_MS = 250;
const FLUSH_SIZE = 8 * 1024;
/** Time between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5000;
/**
 * After the script exits, how long to wait for its output to end; a
 * background process it started may keep the pipes open.
 */
const CLOSE_GRACE_MS = 2000;

/** Secrets of the app that setup scripts (repository code) do not need. */
const HIDDEN_VARIABLES = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/**
 * Runs a repository's setup script with bash (`-e -o pipefail`: it stops
 * at the first failing command) in its own process group, so that the
 * timeout stops everything it started. Processes it leaves running in the
 * background are stopped when it ends.
 */
@Injectable()
export class SetupScriptRunner {
  run(options: SetupScriptOptions): Promise<SetupScriptResult> {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const name of HIDDEN_VARIABLES) {
      delete env[name];
    }
    return new Promise((resolve) => {
      let forwarded = 0;
      let pending = '';
      let tail = '';
      let truncated = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (pending) {
          const text = pending;
          pending = '';
          options.onOutput(text);
        }
      };
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        tail = (tail + text).slice(-TAIL_LENGTH);
        if (forwarded >= MAX_SETUP_OUTPUT) {
          truncated = true;
          return;
        }
        const part = text.slice(0, MAX_SETUP_OUTPUT - forwarded);
        truncated ||= part.length < text.length;
        forwarded += part.length;
        pending += part;
        if (pending.length >= FLUSH_SIZE) {
          flush();
        } else {
          flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
        }
      };

      const child = spawn(
        'bash',
        ['-e', '-o', 'pipefail', '-c', options.script],
        {
          cwd: options.cwd,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, signal);
          }
        } catch {
          // already gone
        }
      };
      const stop = () => {
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
      const onAbort = () => {
        aborted = true;
        stop();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (
        exitCode: number | null,
        signal: string | null,
        error: Error | null,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        options.signal?.removeEventListener('abort', onAbort);
        // Background processes the script left behind are not tracked
        // anywhere; stop them with the script.
        killGroup('SIGTERM');
        child.stdout.destroy();
        child.stderr.destroy();
        flush();
        const durationMs = Date.now() - started;
        const outputTail = truncated ? tail : null;
        if (timedOut) {
          resolve({
            state: 'timed_out',
            exitCode,
            signal,
            durationMs,
            message: `Stopped after ${Math.round(options.timeoutMs / 1000)} s`,
            outputTail,
          });
        } else if (error || aborted || exitCode !== 0) {
          resolve({
            state: 'failed',
            exitCode,
            signal,
            durationMs,
            message: error
              ? `The script could not be started: ${error.message}`
              : aborted
                ? 'Stopped because the session was ended'
                : null,
            outputTail,
          });
        } else {
          resolve({
            state: 'succeeded',
            exitCode,
            signal,
            durationMs,
            message: null,
            outputTail,
          });
        }
      };

      child.on('error', (error) => finish(null, null, error));
      child.on('close', (code, signal) => finish(code, signal, null));
      child.on('exit', (code, signal) => {
        const grace = setTimeout(
          () => finish(code, signal, null),
          CLOSE_GRACE_MS,
        );
        grace.unref?.();
      });
    });
  }
}
