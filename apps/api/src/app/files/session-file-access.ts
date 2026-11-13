import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  PROCESS_LAUNCHER,
  SINGLE_USER,
  type ProcessLauncher,
} from '../common/process-isolation';

export const SESSION_FILES_SCRIPT = 'session-files.cjs';

/**
 * Path of the session file helper: next to the API bundle in `assets/`
 * (build output), or in `src/assets` when running from sources (tests).
 */
export function sessionFilesScript(): string {
  const candidates = [
    join(__dirname, 'assets', SESSION_FILES_SCRIPT),
    join(__dirname, '..', '..', 'assets', SESSION_FILES_SCRIPT),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`${SESSION_FILES_SCRIPT} not found`);
  }
  return found;
}

/** Why a session file could not be read. */
export type FileAccessErrorCode =
  | 'usage'
  | 'outside'
  | 'not_found'
  | 'not_regular'
  | 'no_access'
  | 'failed';

export class FileAccessError extends Error {
  constructor(
    readonly code: FileAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileAccessError';
  }
}

/** A file read from a session's directories. */
export interface SessionFileContent {
  /** Real path (symlinks resolved). */
  path: string;
  /** Size of the file. */
  size: number;
  mtimeMs: number;
  /** The first `maxBytes` bytes. */
  data: Buffer;
  /** The file is larger than what was read. */
  truncated: boolean;
}

const TIMEOUT_MS = 30_000;
/** Room for the JSON line before the content. */
const HEADER_ALLOWANCE = 64 * 1024;

interface HelperHeader {
  ok: boolean;
  code?: FileAccessErrorCode;
  message?: string;
  [key: string]: unknown;
}

/**
 * Reads and lists files of a session's directories through the helper
 * script `session-files.cjs`, run as the session user: in `separate-users`
 * mode the API never opens a session's files with its own privileges (it
 * could read the database or the GitHub App key, and a session could point
 * a symlink there). The helper refuses files whose real path is outside
 * the given directories and anything but regular files.
 */
@Injectable()
export class SessionFileAccess {
  constructor(
    @Optional()
    @Inject(PROCESS_LAUNCHER)
    private readonly launcher: ProcessLauncher = SINGLE_USER,
  ) {}

  /**
   * Reads up to `maxBytes` of a file inside `roots` (relative paths count
   * from the first root). Throws {@link FileAccessError}.
   */
  async read(
    roots: string[],
    path: string,
    maxBytes: number,
  ): Promise<SessionFileContent> {
    const { header, body } = await this.run(
      ['read', String(maxBytes), path, ...roots],
      maxBytes,
    );
    return {
      path: String(header['path']),
      size: Number(header['size']),
      mtimeMs: Number(header['mtimeMs']),
      data: body,
      truncated: header['truncated'] === true,
    };
  }

  /**
   * Files below a directory without git (relative paths), at most
   * `maxEntries`.
   */
  async list(
    root: string,
    maxEntries: number,
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const { header, body } = await this.run(
      ['list', String(maxEntries), root],
      // Paths are bounded by PATH_MAX each.
      maxEntries * 4097,
    );
    const paths = body.toString('utf8').split('\0');
    paths.pop();
    return { paths, truncated: header['truncated'] === true };
  }

  private run(
    args: string[],
    maxBody: number,
  ): Promise<{ header: HelperHeader; body: Buffer }> {
    const command = this.launcher.command('session', process.execPath, [
      sessionFilesScript(),
      ...args,
    ]);
    const limit = maxBody + HEADER_ALLOWANCE;
    return new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        // Readable for every user; the helper uses absolute paths.
        cwd: '/',
        env: this.launcher.environment('session'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let failure: Error | null = null;
      const timer = setTimeout(() => {
        failure = new FileAccessError('failed', 'Reading the file timed out');
        child.kill('SIGKILL');
      }, TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          failure ??= new FileAccessError('failed', 'Unexpected output');
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new FileAccessError('failed', error.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) {
          reject(failure);
          return;
        }
        const output = Buffer.concat(chunks);
        const newline = output.indexOf(0x0a);
        let header: HelperHeader;
        try {
          header = JSON.parse(
            output
              .subarray(0, newline < 0 ? output.length : newline)
              .toString('utf8'),
          ) as HelperHeader;
        } catch {
          reject(
            new FileAccessError(
              'failed',
              `The file helper failed (exit ${code}): ${stderr.trim() || 'no output'}`,
            ),
          );
          return;
        }
        if (!header.ok) {
          reject(
            new FileAccessError(
              header.code ?? 'failed',
              header.message ?? 'The file could not be read',
            ),
          );
          return;
        }
        resolve({ header, body: output.subarray(newline + 1) });
      });
    });
  }
}
