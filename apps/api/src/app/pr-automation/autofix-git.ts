/**
 * The git commands Claude may run without approval during autofix, read
 * strictly from the Bash command text: nothing but `git add`, `git commit`
 * and `git push`, joined with `&&`, optionally after `cd <dir>` or with
 * `git -C <dir>`. The app does not hand such a command to a shell: it runs
 * `git add` and `git commit` itself (as the session user, with hooks off
 * and only known configuration) and pushes the session branch itself. So
 * everything a shell or git could do besides that is refused here, and the
 * command then needs the user's approval as usual.
 */

/** One step the app carries out. */
export type AutofixGitStep =
  | { kind: 'add'; args: string[] }
  | { kind: 'commit'; args: string[]; amend: boolean }
  | { kind: 'push' };

export interface AutofixGitCommand {
  steps: AutofixGitStep[];
  /**
   * Where the git commands run, as written (`cd` and `-C` combined, may be
   * relative); `null` when the command names no directory.
   */
  location: string[] | null;
}

/** Characters of a word outside quotes. */
const PLAIN = /^[A-Za-z0-9_./:@%+=,^~-]+$/;

/**
 * Splits a command into words and `&&`. Single quotes are literal; double
 * quotes may not contain anything the shell would expand (`$`, backtick,
 * backslash, `!`). Anything else (pipes, `;`, redirections, subshells,
 * globbing, newlines outside quotes) gives `null`.
 */
export function shellWords(command: string): string[][] | null {
  const parts: string[][] = [[]];
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === ' ' || char === '\t') {
      index++;
      continue;
    }
    if (char === '&') {
      if (command[index + 1] !== '&' || parts.at(-1)?.length === 0) {
        return null;
      }
      parts.push([]);
      index += 2;
      continue;
    }
    // One word, possibly of several quoted and plain pieces.
    let word = '';
    while (
      index < command.length &&
      command[index] !== ' ' &&
      command[index] !== '\t' &&
      command[index] !== '&'
    ) {
      const current = command[index];
      if (current === "'") {
        const end = command.indexOf("'", index + 1);
        if (end < 0) {
          return null;
        }
        word += command.slice(index + 1, end);
        index = end + 1;
      } else if (current === '"') {
        const end = command.indexOf('"', index + 1);
        if (end < 0) {
          return null;
        }
        const quoted = command.slice(index + 1, end);
        if (/[$`\\!]/.test(quoted)) {
          return null;
        }
        word += quoted;
        index = end + 1;
      } else {
        let end = index;
        while (end < command.length && !/[\s'"&]/.test(command[end])) {
          end++;
        }
        const plain = command.slice(index, end);
        if (!PLAIN.test(plain) || plain.startsWith('~')) {
          return null;
        }
        word += plain;
        index = end;
        if (end < command.length && /[\n\r\v\f]/.test(command[end])) {
          return null;
        }
      }
    }
    parts.at(-1)?.push(word);
  }
  if (parts.some((part) => part.length === 0)) {
    return null;
  }
  return parts;
}

/** Options of `git add` that only choose what is staged. */
const ADD_FLAGS = new Set([
  '-A',
  '--all',
  '-u',
  '--update',
  '--',
  '-v',
  '--verbose',
]);

/** Options of `git commit` that need no value. */
const COMMIT_FLAGS = new Set([
  '-a',
  '--all',
  '-q',
  '--quiet',
  '-s',
  '--signoff',
  '--amend',
  '--no-edit',
  // Hooks never run in the app's git commands, so this changes nothing.
  '--no-verify',
  '-n',
  '-v',
  '--verbose',
]);

/**
 * Reads a command as autofix git steps; `null` when it is anything else.
 * `git push` may come only last and is checked by the push analysis.
 */
export function parseAutofixGitCommand(
  command: string,
): AutofixGitCommand | null {
  const parts = shellWords(command);
  if (!parts) {
    return null;
  }
  const steps: AutofixGitStep[] = [];
  let cd: string[] = [];
  let location: string[] | null = null;
  for (const [position, words] of parts.entries()) {
    if (words[0] === 'cd') {
      if (words.length !== 2 || steps.length > 0) {
        return null;
      }
      cd = [...cd, words[1]];
      continue;
    }
    if (words[0] !== 'git') {
      return null;
    }
    let index = 1;
    const here = [...cd];
    while (index < words.length && words[index].startsWith('-')) {
      if (words[index] === '-C' && index + 1 < words.length) {
        here.push(words[index + 1]);
        index += 2;
      } else {
        // Other git options (-c, --git-dir, --exec-path, ...) are refused.
        return null;
      }
    }
    const where = here.length > 0 ? here : null;
    if (
      steps.length > 0 &&
      JSON.stringify(where) !== JSON.stringify(location)
    ) {
      // All steps must run in the same directory.
      return null;
    }
    location = where;
    const subcommand = words[index];
    const args = words.slice(index + 1);
    if (steps.at(-1)?.kind === 'push') {
      return null;
    }
    if (subcommand === 'add') {
      const step = addStep(args);
      if (!step) {
        return null;
      }
      steps.push(step);
    } else if (subcommand === 'commit') {
      const step = commitStep(args);
      if (!step) {
        return null;
      }
      steps.push(step);
    } else if (subcommand === 'push') {
      if (position !== parts.length - 1) {
        return null;
      }
      steps.push({ kind: 'push' });
    } else {
      return null;
    }
  }
  return steps.length > 0 ? { steps, location } : null;
}

function addStep(args: string[]): AutofixGitStep | null {
  let paths = false;
  for (const arg of args) {
    if (arg === '--') {
      paths = true;
      continue;
    }
    if (!paths && arg.startsWith('-')) {
      if (!ADD_FLAGS.has(arg)) {
        return null;
      }
      continue;
    }
    // Plain paths inside the clone: no pathspec magic, no absolute paths,
    // nothing that leaves the directory.
    if (
      arg.startsWith(':') ||
      arg.startsWith('/') ||
      arg.split('/').includes('..') ||
      arg.includes('*') ||
      arg.length === 0
    ) {
      return null;
    }
  }
  return { kind: 'add', args };
}

function commitStep(args: string[]): AutofixGitStep | null {
  let message = false;
  let amend = false;
  let noEdit = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-m' || arg === '--message') {
      if (index + 1 >= args.length) {
        return null;
      }
      message = true;
      index++;
      continue;
    }
    if (arg.startsWith('--message=')) {
      message = true;
      continue;
    }
    // Combined short options ending in m (`-am "text"`).
    const combined = /^-([aqs]+)m$/.exec(arg);
    if (combined) {
      if (index + 1 >= args.length) {
        return null;
      }
      message = true;
      index++;
      continue;
    }
    if (/^-[aqsn]+$/.test(arg) && arg.length > 2) {
      continue;
    }
    if (!COMMIT_FLAGS.has(arg)) {
      // Paths, -F, -C, -c, --fixup, --author, --date, -S, ...: refused.
      return null;
    }
    amend ||= arg === '--amend';
    noEdit ||= arg === '--no-edit';
  }
  // Without a message git would open an editor.
  if (!message && !(amend && noEdit)) {
    return null;
  }
  return { kind: 'commit', args, amend };
}
