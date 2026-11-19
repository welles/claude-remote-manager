#!/usr/bin/env node
/*
 * GitHub token helper of session processes in the container, where the
 * session user has no GitHub credentials of its own. It asks the session
 * manager's API for a short-lived installation token of the GitHub App,
 * authenticating as the session with CRM_SESSION_TOKEN, which only the
 * session's Claude Code process (and what it starts) has. The API decides
 * what the token covers (see session-github-tokens.service.ts). Nothing is
 * stored.
 *
 *   crm-github.cjs git-credential get   git's credential helper
 *                                       (gitcredentials(7)); `store` and
 *                                       `erase` are ignored
 *   crm-github.cjs gh-token             prints a read-only token for gh
 *                                       (used by the wrapper docker/gh)
 *
 * Plain Node.js without dependencies.
 */
'use strict';

const { spawnSync } = require('node:child_process');

const apiUrl = process.env.CRM_API_URL;
const sessionToken = process.env.CRM_SESSION_TOKEN;

async function requestToken(kind, body) {
  if (!apiUrl || !sessionToken) {
    throw new Error(
      'not running in a session of the session manager (no CRM_SESSION_TOKEN)',
    );
  }
  let response;
  try {
    response = await fetch(`${apiUrl}/api/session-tokens/${kind}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`the session manager is not reachable (${error.message})`);
  }
  let answer = {};
  try {
    answer = await response.json();
  } catch {
    // no JSON
  }
  if (!response.ok) {
    throw new Error(
      answer.message || `the session manager answered ${response.status}`,
    );
  }
  return answer;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function parseCredentialInput(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) {
      values[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return values;
}

async function gitCredential(operation) {
  if (operation !== 'get') {
    return;
  }
  const input = parseCredentialInput(await readStdin());
  try {
    const answer = await requestToken('git', {
      protocol: input.protocol ?? '',
      host: input.host ?? '',
      path: input.path ?? '',
    });
    const lines = [
      `username=${answer.username}`,
      `password=${answer.token}`,
      `password_expiry_utc=${Math.floor(new Date(answer.expiresAt).getTime() / 1000)}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (error) {
    process.stderr.write(`crm credential helper: ${error.message}\n`);
    // Stop looking for credentials: no prompt, no other helper.
    process.stdout.write('quit=1\n');
  }
}

/** owner/name of the working directory's `origin` on GitHub, or null. */
function originRepository() {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const url = (result.stdout || '').trim();
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(
      url,
    );
  return match ? match[1] : null;
}

/**
 * Prints a token for gh on stdout (empty when there is none; the reason
 * goes to stderr). The wrapper docker/gh passes it as GH_TOKEN and then
 * becomes gh itself, so signals and exit codes are gh's.
 */
async function ghToken() {
  try {
    const repository = originRepository();
    const answer = await requestToken('gh', repository ? { repository } : {});
    process.stdout.write(answer.token);
  } catch (error) {
    process.stderr.write(
      `crm gh: no GitHub token (${error.message}); running gh without one\n`,
    );
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'git-credential') {
  gitCredential(rest[0]).catch((error) => {
    process.stderr.write(`crm credential helper: ${error.message}\n`);
    process.stdout.write('quit=1\n');
  });
} else if (mode === 'gh-token') {
  ghToken();
} else {
  process.stderr.write('usage: crm-github.cjs git-credential get | gh-token\n');
  process.exit(2);
}
