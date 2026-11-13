import { join, relative } from 'node:path';
import { handOverToSession } from '../common/ownership';
import { ProcessLauncher, type ProcessRole } from '../common/process-isolation';
import { GitService } from './git.service';
import {
  commitFile,
  createOrigin,
  git,
  gitSandbox,
} from './testing/git-fixtures';

/**
 * A launcher that runs everything as the current user (tests cannot switch
 * users) but records who would run which git command.
 */
class RecordingLauncher extends ProcessLauncher {
  readonly calls: { role: ProcessRole; args: string[] }[] = [];
  constructor() {
    super({ mode: 'single-user' });
  }
  override command(
    role: ProcessRole,
    command: string,
    args: readonly string[],
  ) {
    const gitArgs = args.filter(
      (arg) => arg !== '-c' && arg !== 'core.hooksPath=/dev/null',
    );
    this.calls.push({ role, args: gitArgs });
    return super.command(role, command, args);
  }
  roleOf(subcommand: string): ProcessRole[] {
    return this.calls
      .filter(
        (call) => call.args.find((arg) => !arg.startsWith('-')) === subcommand,
      )
      .map((call) => call.role);
  }
}

describe('who runs which git command', () => {
  let sandbox: ReturnType<typeof gitSandbox>;
  let launcher: RecordingLauncher;
  let service: GitService;
  let origin: string;
  let mirror: string;

  beforeEach(async () => {
    sandbox = gitSandbox();
    launcher = new RecordingLauncher();
    service = new GitService(launcher);
    origin = join(sandbox.dir, 'origin');
    await createOrigin(origin);
    mirror = join(sandbox.dir, 'repos', 'acme', 'app');
    await service.updateMirror(mirror, origin);
  });
  afterEach(() => sandbox.cleanup());

  it('clones as the API (hardlinks), works in the clone as the session user', async () => {
    launcher.calls.length = 0;
    const path = join(sandbox.dir, 'sessions', 's', 'acme', 'app');
    await service.createSessionClone({
      mirrorPath: mirror,
      path,
      remoteUrl: origin,
      branch: 'claude/s',
      baseCommit: await service.branchCommit(mirror, 'main'),
    });
    expect(launcher.roleOf('clone')).toEqual(['api']);
    expect(launcher.roleOf('checkout')).toEqual(['session']);
    expect(launcher.roleOf('config')).toEqual(['session']);
    launcher.calls.length = 0;
    await service.configureClone(path, {
      identity: { name: 'A', email: 'a@example.com' },
      credentialHelper: '!true',
    });
    expect(new Set(launcher.calls.map((call) => call.role))).toEqual(
      new Set(['session']),
    );
  });

  it('pushes from the mirror as the API after the session user bundled the branch', async () => {
    const path = join(sandbox.dir, 'sessions', 's', 'acme', 'app');
    await service.createSessionClone({
      mirrorPath: mirror,
      path,
      remoteUrl: origin,
      branch: 'claude/s',
      baseCommit: await service.branchCommit(mirror, 'main'),
    });
    const base = await git(path, 'rev-parse', 'HEAD');
    await commitFile(path, 'x.txt', 'x');
    launcher.calls.length = 0;
    await service.pushSessionBranch({
      mirrorPath: mirror,
      clonePath: path,
      branch: 'claude/s',
      baseCommit: base,
      auth: async () => null,
    });
    expect(launcher.roleOf('bundle')).toEqual(['session']);
    expect(launcher.roleOf('push')).toEqual(['api']);
    // The API's fetch reads the bundle file, never the session's repository.
    const fetches = launcher.calls.filter((call) =>
      call.args.includes('fetch'),
    );
    expect(fetches.every((call) => call.role === 'api')).toBe(true);
    expect(
      fetches.flatMap((call) => call.args).some((arg) => arg.startsWith(path)),
    ).toBe(false);
  });
});

describe('handOverToSession', () => {
  it('hands everything to the session user except hardlinked objects', async () => {
    const sandbox = gitSandbox();
    try {
      const service = new GitService();
      const origin = join(sandbox.dir, 'origin');
      await createOrigin(origin);
      const mirror = join(sandbox.dir, 'mirror');
      await service.updateMirror(mirror, origin);
      const clone = join(sandbox.dir, 'clone');
      await git(
        sandbox.dir,
        'clone',
        '--local',
        '--quiet',
        '--',
        mirror,
        clone,
      );
      const chowned: string[] = [];
      const launcher = new ProcessLauncher({
        mode: 'separate-users',
        sessionUser: { name: 's', uid: 4242, gid: 4242, home: '/tmp' },
      });
      await handOverToSession(clone, launcher, async (path, uid) => {
        expect(uid).toBe(4242);
        chowned.push(relative(clone, path));
      });
      expect(chowned).toContain('');
      expect(chowned).toContain('README.md');
      expect(chowned).toContain('.git/objects');
      expect(chowned).toContain('.git/config');
      const objectFiles = chowned.filter(
        (path) =>
          path.startsWith('.git/objects/') &&
          /[0-9a-f]{38}$|\.pack$/.test(path),
      );
      expect(objectFiles).toEqual([]);
      // Single-user mode changes nothing.
      const none: string[] = [];
      await handOverToSession(
        clone,
        new ProcessLauncher({ mode: 'single-user' }),
        async (path) => {
          none.push(path);
        },
      );
      expect(none).toEqual([]);
    } finally {
      sandbox.cleanup();
    }
  });
});
