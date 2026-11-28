import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLauncher } from '../../common/process-isolation';

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
