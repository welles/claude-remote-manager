import { readFileSync } from 'node:fs';

/**
 * A secret of the app: read from a file (e.g. a Docker secret) or from its
 * `CRM_SECRET_*` variable, once at startup. Error messages name the file or
 * variable, never the content.
 */
export function readSecret(
  file: string | null,
  variable: string,
  env: Record<string, string | undefined>,
): { value: string | null; problem: string | null } {
  if (file) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      return value
        ? { value, problem: null }
        : { value: null, problem: `${file} is empty` };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        value: null,
        problem: `${file} could not be read${typeof code === 'string' ? ` (${code})` : ''}`,
      };
    }
  }
  const value = env[variable]?.trim();
  return value
    ? { value, problem: null }
    : { value: null, problem: `${variable} is not set` };
}

/** Replaces a secret in a text that may contain it (e.g. an error). */
export function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}
