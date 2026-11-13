/**
 * What a `git push` command (as Claude writes it for the Bash tool) would
 * update, for the approval dialog: the approval of a push lets the
 * credential helper hand out a write token for the whole repository, so
 * the user must see when a command pushes to something else than the
 * session branch, forces, deletes or pushes everything.
 *
 * This reads the command text; it cannot know shell aliases, git aliases
 * or the remote's configuration. Anything it cannot place is reported as
 * unclear, never as harmless.
 */
import type {
  GitPushAnalysis,
  GitPushTarget,
} from '@claude-remote-manager/shared-types';

export type { GitPushAnalysis, GitPushTarget };

const FORCE_OPTIONS = new Set([
  '-f',
  '--force',
  '--force-with-lease',
  '--force-if-includes',
]);
const DELETE_OPTIONS = new Set(['-d', '--delete', '--prune']);
const EVERYTHING_OPTIONS = new Set([
  '--all',
  '--branches',
  '--mirror',
  '--tags',
]);
/** Options of `git push` that take a separate value. */
const VALUE_OPTIONS = new Set([
  '-o',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--exec',
  '--signed',
]);
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'time',
  'nice',
  'nohup',
  'sudo',
]);

/** Words of a shell command part; quotes are removed, nothing is expanded. */
function words(part: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(part))) {
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

function branchOf(destination: string): string | null {
  if (destination === 'HEAD' || destination === '@') {
    return 'HEAD';
  }
  if (destination.startsWith('refs/heads/')) {
    return destination.slice('refs/heads/'.length);
  }
  return destination.startsWith('refs/') ? null : destination;
}

/** Analyzes every `git push` in a shell command. */
export function analyzeGitPushes(
  command: string,
  sessionBranches: readonly string[],
  /** Branches checked out in the session's clones right now. */
  checkedOut: readonly string[] = sessionBranches,
): GitPushAnalysis[] {
  const results: GitPushAnalysis[] = [];
  for (const part of command.split(/&&|\|\||[;&|\n()`{}]|\$\(/)) {
    const all = words(part.trim());
    let index = 0;
    while (
      index < all.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(all[index]) || WRAPPERS.has(all[index]))
    ) {
      index++;
    }
    if (index >= all.length || !/(^|\/)git$/.test(all[index])) {
      continue;
    }
    let next = index + 1;
    while (next < all.length && all[next].startsWith('-')) {
      next += GIT_VALUE_OPTIONS.has(all[next]) ? 2 : 1;
    }
    if (all[next] !== 'push') {
      continue;
    }
    results.push(
      analyze(all.slice(next + 1), part.trim(), sessionBranches, checkedOut),
    );
  }
  return results;
}

function analyze(
  args: string[],
  command: string,
  sessionBranches: readonly string[],
  checkedOut: readonly string[],
): GitPushAnalysis {
  let force = false;
  let deletes = false;
  let everything = false;
  let unclear = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const name = arg.split('=')[0];
    if (FORCE_OPTIONS.has(name)) {
      force = true;
    } else if (DELETE_OPTIONS.has(name)) {
      deletes = true;
    } else if (EVERYTHING_OPTIONS.has(name)) {
      everything = true;
    } else if (/^-[a-zA-Z]{2,}$/.test(arg)) {
      // Combined short options, e.g. -uf.
      force ||= arg.includes('f');
      deletes ||= arg.includes('d');
    } else if (VALUE_OPTIONS.has(arg)) {
      i++;
    }
    if (name === '--repo') {
      unclear = true;
    }
  }
  const [remote = null, ...refspecs] = positional;
  const targets: GitPushTarget[] =
    refspecs.length === 0
      ? [{ destination: 'HEAD', branch: 'HEAD', forced: false, deletes: false }]
      : refspecs.map((refspec) => {
          const forced = refspec.startsWith('+');
          const spec = forced ? refspec.slice(1) : refspec;
          const colon = spec.indexOf(':');
          const source = colon < 0 ? spec : spec.slice(0, colon);
          const destination = colon < 0 ? spec : spec.slice(colon + 1);
          return {
            destination,
            branch: branchOf(destination),
            forced,
            deletes: colon >= 0 && source === '',
          };
        });
  force ||= targets.some((target) => target.forced);
  deletes ||= targets.some((target) => target.deletes);
  const sessions = new Set(sessionBranches);
  // HEAD (or no refspec) pushes the checked-out branch: the session branch
  // unless a clone has another branch checked out.
  const headIsSession = checkedOut.every((branch) => sessions.has(branch));
  const others = targets.filter((target) =>
    target.branch === 'HEAD'
      ? !headIsSession
      : !(target.branch !== null && sessions.has(target.branch)),
  );
  const warnings: string[] = [];
  if (others.length > 0) {
    warnings.push(
      `Pushes to ${others
        .map((target) =>
          target.branch === 'HEAD'
            ? `the checked-out branch (${checkedOut.filter((branch) => !sessions.has(branch)).join(', ')})`
            : target.destination,
        )
        .join(', ')}, not only the session branch`,
    );
  }
  if (force) {
    warnings.push('Force push: may overwrite commits on the remote');
  }
  if (deletes) {
    warnings.push('Deletes branches on the remote');
  }
  if (everything) {
    warnings.push('Pushes all branches or tags, not a named branch');
  }
  if (unclear || (remote !== null && remote !== 'origin')) {
    warnings.push(`Pushes to the remote "${remote ?? '?'}", not origin`);
  }
  return {
    command,
    remote,
    targets,
    force,
    deletes,
    everything,
    sessionBranchOnly: warnings.length === 0,
    warnings,
  };
}
