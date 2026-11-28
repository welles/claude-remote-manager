import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The machine's Codex rules (next to its managed configuration). */
export const SYSTEM_CODEX_RULES = '/etc/codex/rules';

/** A rules file says something (lines other than comments and blanks). */
function hasRules(text: string): boolean {
  return text
    .split('\n')
    .some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/**
 * Codex's command rules (`prefix_rule(…)` in `*.rules` files) that could
 * let commands run past a review's read-only setup: in each Codex home's
 * `rules/` (followed where it is a link into the base home), the
 * machine's `/etc/codex/rules/` and the working directory's
 * `.codex/rules/`. The reason not to review with
 * Codex, `null` when there are none. A directory that cannot be read
 * counts as having rules (it cannot be checked).
 */
export async function codexRulesReason(
  homes: readonly string[],
  cwd: string,
  systemRules = SYSTEM_CODEX_RULES,
): Promise<string | null> {
  const dirs = [
    ...new Set([
      ...homes.map((home) => join(home, 'rules')),
      systemRules,
      join(cwd, '.codex', 'rules'),
    ]),
  ];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      return `Codex's rules in ${dir} could not be checked`;
    }
    for (const name of names.filter((entry) => entry.endsWith('.rules'))) {
      let text: string;
      try {
        text = await readFile(join(dir, name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EISDIR') {
          continue;
        }
        return `Codex's rules in ${dir} could not be checked`;
      }
      if (hasRules(text)) {
        return `Codex has command rules (${join(dir, name)}) that could let commands run past the reviewer's read-only setup`;
      }
    }
  }
  return null;
}
