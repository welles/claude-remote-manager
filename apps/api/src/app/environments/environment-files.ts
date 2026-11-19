import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handOverToSession } from '../common/ownership';
import type { ProcessLauncher } from '../common/process-isolation';

/** A file of an environment to write for a process. */
export interface MaterializedFile {
  variable: string;
  fileName: string;
  content: string;
}

/** Files written for one process, see {@link EnvironmentFiles.write}. */
export interface WrittenFiles {
  /** Directory of the files; remove it with {@link EnvironmentFiles.remove}. */
  dir: string;
  /** Variables with the files' paths. */
  env: Record<string, string>;
}

/**
 * Writes the files of an environment for one process of a session (the
 * Claude Code process or a setup script) into a directory of its own below
 * `root`, outside the session's clones: `0700`, the files `0600`, owned by
 * the session user. The root is checked to be a real directory of the
 * API's user (it may sit in a shared temporary directory).
 */
export class EnvironmentFiles {
  constructor(
    private readonly root: string,
    private readonly launcher: ProcessLauncher,
  ) {}

  async write(
    sessionId: string,
    files: MaterializedFile[],
  ): Promise<WrittenFiles | null> {
    if (files.length === 0) {
      return null;
    }
    await this.ensureRoot();
    const dir = join(this.root, `${sessionId}-${randomUUID()}`);
    await mkdir(dir, { mode: 0o700 });
    try {
      const env: Record<string, string> = {};
      for (const file of files) {
        const path = join(dir, file.fileName);
        await writeFile(path, file.content, { mode: 0o600, flag: 'wx' });
        env[file.variable] = path;
      }
      await handOverToSession(dir, this.launcher);
      return { dir, env };
    } catch (error) {
      await this.remove(dir);
      throw error;
    }
  }

  /** Removes a directory {@link write} returned. */
  async remove(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  /** Removes the files of all processes (at startup: none runs). */
  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.root);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(
        `${this.root} is not a directory of the app; environment files are not written`,
      );
    }
    // Explicitly, whatever the umask: the session user only passes
    // through the root to its own directories.
    await chmod(this.root, this.launcher.separated ? 0o711 : 0o700);
  }
}
