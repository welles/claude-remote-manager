import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shellScript, shellWords } from './codex-events';

/**
 * Programs that only read and write nothing but their output, whatever
 * their arguments (no option of theirs writes a file or runs a program).
 */
const READING_PROGRAMS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'pwd',
  'nl',
  'stat',
  'grep',
  'egrep',
  'fgrep',
  'echo',
  'true',
  'du',
  'diff',
  'cmp',
  'cut',
  'basename',
  'dirname',
  'realpath',
  'readlink',
]);

/** git subcommands that only read (with the options below refused). */
const READING_GIT = new Set([
  'diff',
  'log',
  'show',
  'status',
  'blame',
  'ls-files',
  'grep',
  'rev-parse',
]);

/** Options that make a reading program write a file or run one. */
const REFUSED_OPTIONS: Record<string, readonly string[]> = {
  // Preprocessors and decompressors run programs.
  rg: ['--pre', '--pre-glob', '-z', '--search-zip', '--hostname-bin'],
  find: [
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    '-delete',
    '-fls',
    '-fprint',
    '-fprint0',
    '-fprintf',
  ],
  // Writes files, runs external diff programs or a pager.
  git: ['--output', '--ext-diff', '-O', '--open-files-in-pager', '--paginate'],
};

function refused(program: string, args: readonly string[]): boolean {
  const options = REFUSED_OPTIONS[program] ?? [];
  return args.some((arg) =>
    options.some(
      (option) =>
        arg === option ||
        arg.startsWith(`${option}=`) ||
        // `-O<pager>`, `-zfoo` and the like.
        (/^-[A-Za-z]$/.test(option) && arg.startsWith(option)),
    ),
  );
}

/**
 * Whether a command Codex asks to run (wrapped in its shell, as it reports
 * them) is one simple command that only reads: a program of a short list
 * (`cat`, `ls`, `grep`, …), `rg` and `find` without their options that run
 * programs or write, `sed -n <N>p`/`<N>,<M>p` and reading git subcommands
 * (`diff`, `log`, `show`, `status`, …). No operators, redirections,
 * expansions, globs or environment assignments; the program by name, not
 * by path. Everything else is refused (also when the quoting cannot be
 * read). For a review whose sandbox cannot start (see
 * `CodexRunner.review`).
 */
export function isReadOnlyCommand(command: string): boolean {
  const { script, exact } = shellScript(command);
  if (!exact) {
    return false;
  }
  const words = shellWords(script.trim());
  if (!words || words.length === 0) {
    return false;
  }
  const [program, ...args] = words;
  if (READING_PROGRAMS.has(program)) {
    return true;
  }
  switch (program) {
    case 'rg':
    case 'find':
      return !refused(program, args);
    case 'sed':
      return (
        args.length >= 2 &&
        args[0] === '-n' &&
        /^\d+(,\d+)?p$/.test(args[1]) &&
        args.slice(2).every((arg) => !arg.startsWith('-'))
      );
    case 'git':
      return (
        args.length >= 1 &&
        READING_GIT.has(args[0]) &&
        !refused('git', args.slice(1))
      );
    default:
      return false;
  }
}

/** A rules file says something (lines other than comments and blanks). */
function hasRules(text: string): boolean {
  return text
    .split('\n')
    .some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/**
 * Codex's command rules (`prefix_rule(…)` in `*.rules` files) that could
 * let commands run past a review's read-only setup: in each Codex home's
 * `rules/` (followed where it is a link into the base home) and in the
 * working directory's `.codex/rules/`. The reason not to review with
 * Codex, `null` when there are none. A directory that cannot be read
 * counts as having rules (it cannot be checked).
 */
export async function codexRulesReason(
  homes: readonly string[],
  cwd: string,
): Promise<string | null> {
  const dirs = [
    ...new Set([
      ...homes.map((home) => join(home, 'rules')),
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
