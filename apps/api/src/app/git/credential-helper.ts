import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const CREDENTIAL_HELPER_FILE = 'git-credential-crm.cjs';

/**
 * Path of the credential helper script: next to the API bundle in
 * `assets/` (build output), or in `src/assets` when running from sources
 * (tests).
 */
export function credentialHelperScript(): string {
  const candidates = [
    join(__dirname, 'assets', CREDENTIAL_HELPER_FILE),
    join(__dirname, '..', '..', 'assets', CREDENTIAL_HELPER_FILE),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`${CREDENTIAL_HELPER_FILE} not found`);
  }
  return found;
}

/**
 * `credential.helper` value of session clones: the helper script run with
 * this Node.js (absolute paths, so a session's PATH does not matter).
 */
export function credentialHelperCommand(
  node = process.execPath,
  script = credentialHelperScript(),
): string {
  for (const path of [node, script]) {
    if (path.includes("'")) {
      throw new Error(`Unsupported path for the credential helper: ${path}`);
    }
  }
  return `!'${node}' '${script}'`;
}
