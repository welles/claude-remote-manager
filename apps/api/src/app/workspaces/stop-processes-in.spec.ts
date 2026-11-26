import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../sessions/testing/fake-agent';

const SCRIPT = join(__dirname, '..', '..', 'assets', 'stop-processes-in.cjs');

/** Runs the script as this user; resolves its JSON line. */
function stop(
  spared: number,
  directory: string,
): Promise<{ ok: boolean; stopped?: number[] }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT, '200', String(spared), directory],
      (error, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(error ?? new Error(stdout));
        }
      },
    );
  });
}

describe('stop-processes-in.cjs', () => {
  let base: string;
  let clone: string;
  const children: ChildProcess[] = [];

  const idle = (cwd: string) => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        cwd,
        stdio: 'ignore',
      },
    );
    children.push(child);
    return child;
  };
  const running = (child: ChildProcess) =>
    child.exitCode === null && child.signalCode === null;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'crm-stop-')));
    clone = join(base, 's1', 'acme', 'app');
    mkdirSync(join(clone, 'web'), { recursive: true });
    mkdirSync(join(base, 's1', 'acme', 'app-2'), { recursive: true });
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('stops the processes that run in the directory, and only those', async () => {
    const inside = idle(join(clone, 'web'));
    const sibling = idle(join(base, 's1', 'acme', 'app-2'));
    const above = idle(base);
    await waitFor(() => [inside, sibling, above].every((child) => child.pid));

    const result = await stop(0, clone);

    expect(result).toEqual({ ok: true, stopped: [inside.pid] });
    await waitFor(() => !running(inside));
    expect(running(sibling)).toBe(true);
    expect(running(above)).toBe(true);
  });

  it('spares the direct children of the given process (Claude Code)', async () => {
    const claude = idle(clone);
    await waitFor(() => Boolean(claude.pid));

    const result = await stop(process.pid, clone);

    expect(result).toEqual({ ok: true, stopped: [] });
    expect(running(claude)).toBe(true);
  });

  it('refuses a directory that is not absolute and normalized', async () => {
    for (const bad of ['/', 'relative', `${clone}/../app`, `${clone}/`]) {
      expect(await stop(0, bad)).toMatchObject({ ok: false });
    }
  });
});
