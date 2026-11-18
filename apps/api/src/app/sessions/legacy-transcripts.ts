import { cp, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Written into the old directory once its transcripts were copied. */
export const LEGACY_MARKER = 'COPIED-TO-CLAUDE-CONFIG.txt';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface LegacyMigration {
  /** Transcript entries (files and directories) copied. */
  copied: number;
  /** Entries left alone because the target had them already. */
  skipped: number;
  /** Whether the repository memory moved to `memoryDir`. */
  memoryMoved: boolean;
}

/**
 * Earlier versions of the NixOS module ran sessions with a configuration
 * directory of their own (`<dataDir>/claude`); sessions now use the user's
 * (`~/.claude`). Claude Code resumes a session only from the transcript in
 * its current configuration directory, so the transcripts of sessions
 * created back then are copied over once, at startup:
 *
 * - every entry of `<legacy>/projects/<project>/` (transcripts
 *   `<session>.jsonl`, their subagent directories, the auto-memory of
 *   scratch sessions) that the target's `projects/<project>/` lacks; the
 *   project names are the working directories, which did not change;
 * - the shared repository memory `<legacy>/repository-memory` becomes
 *   `memoryDir` if that does not exist yet (moved: only the app uses it).
 *
 * Nothing is deleted: the old directory stays (with a marker file that
 * keeps this from running again) until the owner removes it. Entries the
 * target has already are never overwritten.
 */
export async function migrateLegacyTranscripts(
  legacyDir: string,
  targetDir: string,
  memoryDir: string,
): Promise<LegacyMigration | null> {
  if (
    !(await exists(legacyDir)) ||
    (await exists(join(legacyDir, LEGACY_MARKER)))
  ) {
    return null;
  }
  const result: LegacyMigration = { copied: 0, skipped: 0, memoryMoved: false };
  const legacyProjects = join(legacyDir, 'projects');
  if (await exists(legacyProjects)) {
    for (const project of await readdir(legacyProjects, {
      withFileTypes: true,
    })) {
      if (!project.isDirectory()) {
        continue;
      }
      const from = join(legacyProjects, project.name);
      const to = join(targetDir, 'projects', project.name);
      for (const entry of await readdir(from)) {
        const target = join(to, entry);
        if (await exists(target)) {
          result.skipped++;
          continue;
        }
        await cp(join(from, entry), target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
        result.copied++;
      }
    }
  }
  const legacyMemory = join(legacyDir, 'repository-memory');
  if ((await exists(legacyMemory)) && !(await exists(memoryDir))) {
    try {
      await rename(legacyMemory, memoryDir);
    } catch {
      // Another file system: copy (the old one stays).
      await cp(legacyMemory, memoryDir, {
        recursive: true,
        preserveTimestamps: true,
      });
    }
    result.memoryMoved = true;
  }
  await writeFile(
    join(legacyDir, LEGACY_MARKER),
    `Claude Remote Manager copied the session transcripts of this directory to ${targetDir}/projects` +
      (result.memoryMoved
        ? ` and moved repository-memory to ${memoryDir}`
        : '') +
      ` on ${new Date().toISOString()}.\nSessions now use that configuration directory; this one is no longer used and can be removed once the old sessions resume fine.\n`,
  );
  return result;
}
