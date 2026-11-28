import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The fake `codex app-server` (see `fake-codex.cjs` for its scenarios). */
export const FAKE_CODEX_SCRIPT = join(__dirname, 'fake-codex.cjs');

/**
 * Writes a `codex` executable into `<dir>/bin` that runs the fake with this
 * Node.js (whatever the PATH of the process environment is).
 */
export function writeFakeCodex(dir: string): string {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const executable = join(dir, 'bin', 'codex');
  writeFileSync(
    executable,
    `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_SCRIPT}' "$@"\n`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

/** The requests the fake got with this Codex home, in order. */
export function fakeCodexRequests(
  home: string,
): { method: string; params: Record<string, unknown> | null }[] {
  const file = join(home, 'fake-codex-requests.jsonl');
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The process IDs of the fakes started with this Codex home. */
export function fakeCodexPids(home: string): number[] {
  const file = join(home, 'fake-codex-pids');
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number)
    : [];
}

/** Waits until a process has ended (`false`: still running at the end). */
export async function processEnded(
  pid: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
