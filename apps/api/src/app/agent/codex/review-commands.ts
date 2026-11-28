import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The machine's Codex rules (next to its managed configuration). */
export const SYSTEM_CODEX_RULES = '/etc/codex/rules';

/**
 * Whether a rules file may allow something: a rule call (`prefix_rule(…)`,
 * `network_rule(…)`, …) whose `decision` is not the literal `"prompt"` or
 * `"forbidden"` (Codex's default decision is `allow`, checked with
 * `codex execpolicy check` 0.171; a decision from a variable counts as
 * allowing). Whole-line comments are left out.
 */
export function allowsSomething(text: string): boolean {
  const code = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const call = /\b[A-Za-z_]*_rule\s*\(/g;
  for (const match of code.matchAll(call)) {
    // The call's arguments, up to its balanced closing parenthesis.
    let depth = 0;
    let end = code.length;
    for (
      let i = (match.index ?? 0) + match[0].length - 1;
      i < code.length;
      i++
    ) {
      if (code[i] === '(') {
        depth++;
      } else if (code[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    const args = code.slice(match.index ?? 0, end);
    if (!/\bdecision\s*=\s*(["'])(prompt|forbidden)\1/.test(args)) {
      return true;
    }
  }
  return false;
}

/**
 * Codex's rules that could let commands run past a review's read-only
 * setup (see {@link allowsSomething}; rules that only ask or forbid do
 * not count): in each Codex home's `rules/` (followed where it is a link
 * into the base home) and the machine's `/etc/codex/rules/`. Not the
 * working directory's `.codex/rules/`: the review marks the project
 * untrusted, so Codex does not load them. The reason not to review with
 * Codex, `null` when there are none. A directory or file that cannot be
 * read counts as allowing (it cannot be checked).
 */
export async function codexRulesReason(
  homes: readonly string[],
  systemRules = SYSTEM_CODEX_RULES,
): Promise<string | null> {
  const dirs = [
    ...new Set([...homes.map((home) => join(home, 'rules')), systemRules]),
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
      if (allowsSomething(text)) {
        return `Codex has rules that allow commands (${join(dir, name)}), which could run past the reviewer's read-only setup`;
      }
    }
  }
  return null;
}
