#!/usr/bin/env node
/*
 * Git credential helper of session clones (configured by the session
 * manager as `credential.helper` of each clone of a GitHub repository).
 *
 * git runs it with `get` and the remote on stdin (protocol, host, path; the
 * clone sets `credential.useHttpPath`). It asks the session manager's API
 * for a short-lived installation token for exactly that repository,
 * authenticating as the session with the token in CRM_SESSION_TOKEN, which
 * only the session's Claude Code process (and what it starts) has. The API
 * decides what the token may do: read only, unless the user approved a
 * `git push` that is running right now. Nothing is stored: `store` and
 * `erase` are ignored.
 *
 * Plain Node.js without dependencies; output follows git's credential
 * protocol (gitcredentials(7)).
 */
'use strict';

const operation = process.argv[2];
if (operation !== 'get') {
  process.exit(0);
}

const apiUrl = process.env.CRM_API_URL;
const sessionToken = process.env.CRM_SESSION_TOKEN;

function readInput() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function parse(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) {
      values[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return values;
}

function fail(message) {
  process.stderr.write(`crm credential helper: ${message}\n`);
  // Tell git to stop looking for credentials (no prompt, no other helper).
  process.stdout.write('quit=1\n');
  process.exit(0);
}

async function main() {
  const input = parse(await readInput());
  if (!apiUrl || !sessionToken) {
    fail('not running in a session of the session manager');
  }
  let response;
  try {
    response = await fetch(`${apiUrl}/api/git/credentials`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        protocol: input.protocol ?? '',
        host: input.host ?? '',
        path: input.path ?? '',
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`the session manager is not reachable (${error.message})`);
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    // no JSON
  }
  if (!response.ok) {
    fail(body.message || `the session manager answered ${response.status}`);
  }
  if (body.note) {
    process.stderr.write(`crm credential helper: ${body.note}\n`);
  }
  const lines = [`username=${body.username}`, `password=${body.password}`];
  if (body.expiresAt) {
    lines.push(
      `password_expiry_utc=${Math.floor(new Date(body.expiresAt).getTime() / 1000)}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => fail(error.message));
