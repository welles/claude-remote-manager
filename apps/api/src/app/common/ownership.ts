import { lchown, lstat, opendir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { ProcessLauncher } from './process-isolation';

/**
 * Hands a directory tree the API created (a session clone, a scratch or
 * memory directory) to the session user. In a session clone the object
 * files hardlinked from the mirror keep the API as owner: they are the
 * mirror's own files (one inode), changing their owner would change the
 * mirror's; they are read-only, and the session can still remove its links
 * to them (it owns the directories), which is all `git gc` needs. No-op in
 * single-user mode.
 */
export async function handOverToSession(
  root: string,
  launcher: ProcessLauncher,
  chown: (path: string, uid: number, gid: number) => Promise<void> = lchown,
): Promise<void> {
  const user = launcher.sessionUser;
  if (!user) {
    return;
  }
  const objects = `${sep}.git${sep}objects${sep}`;
  const visit = async (path: string): Promise<void> => {
    const stats = await lstat(path);
    if (stats.isFile() && stats.nlink > 1 && path.includes(objects)) {
      return;
    }
    await chown(path, user.uid, user.gid);
    if (stats.isDirectory()) {
      const dir = await opendir(path);
      for await (const entry of dir) {
        await visit(join(path, entry.name));
      }
    }
  };
  await visit(root);
}
