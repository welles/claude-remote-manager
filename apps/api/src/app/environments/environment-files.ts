import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
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
  /** Paths of the files in it. */
  paths: string[];
  /** Variables with the files' paths. */
  env: Record<string, string>;
}

/**
 * Writes the files of an environment for one process of a session (the
 * Claude Code process or a setup script) into a directory of its own below
 * `root`, outside the session's clones. The root and the directories stay
 * the API's (`0711` with separate users, so the session user can open its
 * files by path but cannot list or add entries; else `0700`); only the
 * files (`0600`) are handed to the session user. So nothing a session
 * runs can put a symlink where the API removes files (with its
 * capabilities): {@link remove} unlinks the known files and removes the
 * empty directory, nothing recursive. The root is checked to be a real
 * directory of the API's user (it may sit in a shared temporary
 * directory).
 */
export class EnvironmentFiles {
  constructor(
    private readonly root: string,
    private readonly launcher: ProcessLauncher,
  ) {}

  private get dirMode(): number {
    return this.launcher.separated ? 0o711 : 0o700;
  }

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
    await chmod(dir, this.dirMode);
    const written: WrittenFiles = { dir, paths: [], env: {} };
    try {
      for (const file of files) {
        const path = join(dir, file.fileName);
        await writeFile(path, file.content, { mode: 0o600, flag: 'wx' });
        written.paths.push(path);
        // The file only, never the directory.
        await handOverToSession(path, this.launcher);
        written.env[file.variable] = path;
      }
      return written;
    } catch (error) {
      await this.remove(written);
      throw error;
    }
  }

  /** Removes what {@link write} returned: its files, then the directory. */
  async remove(written: WrittenFiles): Promise<void> {
    for (const path of written.paths) {
      await rm(path, { force: true });
    }
    await rmdir(written.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }

  /**
   * Removes the files of all processes (at startup: none runs). Recursive
   * is safe here: the session user cannot add entries below the root.
   */
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
    // through the root to its own files.
    await chmod(this.root, this.dirMode);
  }
}
