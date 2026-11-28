import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  findExecutable,
  type ProcessLauncher,
} from '../../common/process-isolation';

/**
 * The Codex home whose configuration, instructions, prompts, skills and
 * conversations all ChatGPT accounts share: `CODEX_HOME`, else `~/.codex`
 * of the session user (as Codex in a terminal of that user). Each account
 * has its own home below it (`crm-accounts/<id>`) with its login.
 */
export function codexBaseHome(
  launcher: ProcessLauncher,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env['CODEX_HOME'];
  if (configured) {
    return configured;
  }
  return join(launcher.sessionUser?.home ?? homedir(), '.codex');
}

/** The target triples of Codex's platform packages. */
const CODEX_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

/**
 * The Codex executable the sessions run: `CODEX_EXECUTABLE`, else the
 * native binary of the app's pinned `@openai/codex` for this platform
 * (`CODEX_VERSION`), else `codex` on the PATH; `null` without Codex.
 */
export function resolveCodexExecutable(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (configured) {
    return configured;
  }
  const platform = `${process.platform}-${process.arch}`;
  const triple = CODEX_TRIPLES[platform];
  if (triple) {
    const from = process.argv[1] || join(process.cwd(), 'index.js');
    try {
      return createRequire(from).resolve(
        `@openai/codex-${platform}/vendor/${triple}/bin/codex`,
      );
    } catch {
      // not installed
    }
  }
  return findExecutable('codex', env['PATH'] ?? '');
}
