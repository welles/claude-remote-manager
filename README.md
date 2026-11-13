# Claude Remote Manager

A self-hosted web frontend for managing Claude Code sessions on a home server: sessions that
work on several repositories at once, each in its own clone of the repository, with live chat, diffs and
cleanup. Everything runs in one Docker container. See [docs/specification.md](docs/specification.md)
(German) for the full specification.

Current state: repositories are chosen from GitHub through the app's GitHub App (or registered
by clone URL), local projects by name; sessions run through the Claude Agent SDK in their own
clones of one or more repositories (or in a scratch directory) and stream to the chat view,
where Claude's approval requests, questions and plans are answered; model and permission mode
are chosen per session and switchable while it runs; messages sent while Claude works are
queued; Claude's task list, the context window and the account's plan limits are shown; every
file change appears as a diff in the history and in approvals, and a changes page shows the
whole session's diff per repository and file; images can be attached to messages, files of the
session referenced with `@`, GitHub issues and pull requests with `#` (Claude gets their
content as untrusted context), and Claude shows files to the user with `show_file`; session
branches are pushed and pull requests created by button, or by Claude after the user's
approval; usage is recorded per request. Sessions notify the user over Web Push and ntfy
(approvals with Allow and Deny right in the notification), and the web app is an installable
PWA with an offline shell, badge, shortcuts and a share target. Per open pull request,
autofix continues the session when CI fails or reviewers with write access comment, and
autoclose ends the session and removes its clones when the pull request is merged or closed
(see [PR automation](#pr-automation)). Dev servers Claude starts become previews on host names
of their own, opened as links or embedded (see [Previews](#previews-of-dev-servers)). The
cleanup of sessions follows.

## Workspace layout

Nx monorepo with npm:

| Path                 | Contents                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `apps/web`           | Angular app (standalone components, Angular Material, SCSS, Vitest)          |
| `apps/api`           | NestJS backend (Jest); serves the built web app and the API under `/api`     |
| `libs/shared-types`  | Types shared by both apps, imported as `@claude-remote-manager/shared-types` |
| `docker/`            | Files for the image: entrypoint, Nix config, global `CLAUDE.md`              |
| `Dockerfile`         | Multi-stage image build                                                      |
| `docker-compose.yml` | Local container setup with all volumes                                       |

## Development

Requires Node.js 24 and npm.

```sh
npm ci
npm start              # web app on http://localhost:4200, starts the API (port 3000) too
npm run start:api      # API only
# both set AUTH_MODE=none and PROCESS_ISOLATION=single-user (local development)
npm run check          # lint, test and build all projects, as in CI
npm run lint           # or: npm test, npm run build
npm run format         # Prettier
npm run db:generate    # SQL migration after changing apps/api/src/app/db/schema.ts
```

The scripts wrap Nx; use `npx nx <target> <project>` for a single project, e.g. `npx nx test web`.

The Angular dev server proxies `/api`, including the WebSocket, to the API
(`apps/web/proxy.conf.json`). In production the API serves the built web app itself from
`WEB_ROOT`.

### Trying it locally

Sessions use the Claude account that Claude Code is logged in with (`claude auth status`; the
config directory is `~/.claude` or `CLAUDE_CONFIG_DIR`). Never an API key.

```sh
npm start                        # then open http://localhost:4200
```

Set the git author name and email on the Settings page first (commits in session clones are
made with them). Add a repository on the Repositories page (from GitHub if the GitHub App is
configured, see [GitHub](#github); or any clone URL git can use with the credentials of your
shell, or a local path), then start a session on it with a short prompt (choose Haiku to
keep it cheap), watch the answer stream in, send a follow-up, restart the API and send another
message: the session is resumed. Mirrors, session clones and scratch directories live in
`~/.local/share/claude-remote-manager/workspace` by default, outside this repository; the
database lives in `data/db` of this repository (gitignored).

For GitHub, start it with `GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_FILE=/path/to/key.pem`.

In development (`PROCESS_ISOLATION=single-user`) the API and the sessions run as you, with
your global git configuration: credentials for repositories registered by clone URL, and
settings such as commit signing apply in session clones too. To keep them apart, start the
API with `GIT_CONFIG_GLOBAL` pointing to a separate file. The tests never use your git
configuration (each test runs git with its own).

Start the API from a normal shell. Started from inside a Claude Code session it inherits that
session's `CLAUDE_*`/`ANTHROPIC_*` variables and passes them on to the sessions it runs.

### Environment variables of the API

| Variable                            | Default (development)                                                                            | Purpose                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `PORT`                              | `3000` (image: `8080`)                                                                           | HTTP and WebSocket port                                                                                  |
| `DB_DIR`                            | `data/db` in the working directory (image: `/data/db`)                                           | SQLite database `claude-remote-manager.sqlite`                                                           |
| `FILES_DIR`                         | `$DB_DIR/files`                                                                                  | The API's own files: attached images, snapshots of shown files (not for sessions)                        |
| `WORKSPACE_DIR`                     | `~/.local/share/claude-remote-manager/workspace`                                                 | `repos/`, `sessions/`, `scratch/` on one filesystem                                                      |
| `SETUP_SCRIPT_TIMEOUT_MINUTES`      | `15`                                                                                             | Setup scripts are stopped after this long                                                                |
| `SESSION_IDLE_TIMEOUT_MINUTES`      | `60`                                                                                             | Close Claude Code processes idle this long; `0` keeps them                                               |
| `CLAUDE_CODE_EXECUTABLE`            | the binary bundled with the Agent SDK                                                            | Other Claude Code executable for the sessions                                                            |
| `CLAUDE_CONFIG_DIR`                 | `~/.claude` (image: `/data/claude`)                                                              | Read by Claude Code: login, settings, transcripts                                                        |
| `MEMORY_DIR`                        | `$CLAUDE_CONFIG_DIR/repository-memory`, without it `~/.local/share/claude-remote-manager/memory` | Claude Code's auto-memory per repository                                                                 |
| `GITHUB_APP_ID`                     | none (GitHub not configured)                                                                     | App ID of the GitHub App (plain configuration)                                                           |
| `GITHUB_APP_PRIVATE_KEY_FILE`       | none                                                                                             | File with the app's private key (PEM), e.g. a Docker secret                                              |
| `CRM_SECRET_GITHUB_APP_PRIVATE_KEY` | none                                                                                             | The private key itself, instead of the file                                                              |
| `AUTH_MODE`                         | none, required                                                                                   | `cloudflare-access` or `none`, see [Authentication](#authentication)                                     |
| `CF_ACCESS_TEAM_DOMAIN`             | none                                                                                             | Team domain (`<team>.cloudflareaccess.com`) for `cloudflare-access`                                      |
| `CF_ACCESS_AUD`                     | none                                                                                             | Application Audience (AUD) tag(s), comma-separated                                                       |
| `CF_ACCESS_ALLOWED_EMAILS`          | none (everyone Access lets in)                                                                   | Optional comma-separated email allowlist                                                                 |
| `PROCESS_ISOLATION`                 | none, required (image: `separate-users`)                                                         | `separate-users` or `single-user`, see [Users](#users-and-what-sessions-can-reach)                       |
| `SESSION_USER`                      | `claude`                                                                                         | OS user of session processes with `separate-users`                                                       |
| `INTERNAL_API_URL`                  | `http://127.0.0.1:$PORT`                                                                         | How the git credential helper in session clones reaches the API                                          |
| `WEB_ROOT`                          | `public` next to the bundle (image: `/app/public`)                                               | Built web app served by the API                                                                          |
| `ALLOWED_HOSTS`                     | none (loopback names are always allowed)                                                         | Comma-separated host names the server answers to                                                         |
| `ALLOWED_ORIGINS`                   | `http://localhost:4200` outside production                                                       | Comma-separated origins besides the server's own                                                         |
| `PUBLIC_URL`                        | none                                                                                             | Public URL of the app, e.g. `https://crm.example.com`: ntfy links open sessions there                    |
| `SESSION_STALL_MINUTES`             | `15`                                                                                             | A running turn without any event this long "hangs" (notification); `0` never                             |
| `NTFY_URL`                          | none (ntfy off)                                                                                  | ntfy server, e.g. `https://ntfy.example.com`                                                             |
| `NTFY_TOPIC`                        | none                                                                                             | ntfy topic (letters, digits, `_`, `-`)                                                                   |
| `NTFY_TOKEN_FILE`                   | none                                                                                             | File with the ntfy access token (required with `NTFY_URL`), e.g. a Docker secret                         |
| `CRM_SECRET_NTFY_TOKEN`             | none                                                                                             | The ntfy access token itself, instead of the file                                                        |
| `VAPID_PRIVATE_KEY_FILE`            | none (keys generated into `DB_DIR`)                                                              | File with the VAPID private key (base64url), to use own keys                                             |
| `CRM_SECRET_VAPID_PRIVATE_KEY`      | none                                                                                             | The VAPID private key itself, instead of the file                                                        |
| `VAPID_PUBLIC_KEY`                  | derived from the private key                                                                     | Optional; checked against the private key                                                                |
| `VAPID_SUBJECT`                     | `PUBLIC_URL` if https, else a placeholder `mailto:`                                              | Contact for the push services (`mailto:` or `https:`)                                                    |
| `GITHUB_WEBHOOK_SECRET_FILE`        | none (webhook refuses everything)                                                                | File with the GitHub App's webhook secret (at least 16 characters), e.g. a Docker secret                 |
| `CRM_SECRET_GITHUB_WEBHOOK_SECRET`  | none                                                                                             | The webhook secret itself, instead of the file                                                           |
| `PR_POLL_INTERVAL_SECONDS`          | `120` without webhook secret, `900` with one                                                     | How often open pull requests with automation are read from GitHub; `0` off, else >= 30                   |
| `PREVIEW_URL`                       | none (previews off; `npm start`: `http://preview.localhost:3000`)                                | Base of preview host names, e.g. `https://preview.example.com`, see [Previews](#previews-of-dev-servers) |
| `PREVIEW_ACCESS_AUD`                | none, required with `cloudflare-access` and `PREVIEW_URL`                                        | Audience tag(s) of the previews' own Access application; never one of `CF_ACCESS_AUD`                    |

Secrets of the app are never passed to the processes it starts (Claude Code, setup scripts,
its own git commands): every variable named `CRM_SECRET_*` is removed, plus a registry of fixed
names in `apps/api/src/app/common/child-environment.ts` (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN`, which only Claude Code gets). New
secrets must use the `CRM_SECRET_` prefix, so a forgotten registration still keeps them out.
The GitHub App's private key is read once at startup and kept only in the API's memory (see
[GitHub](#github) for what that does and does not protect).

### Authentication

`AUTH_MODE` has no default; the API refuses to start without it.

- `cloudflare-access` (production): the API verifies the Cloudflare Access token of every HTTP
  request and WebSocket upgrade itself, also for the static web app: header
  `Cf-Access-Jwt-Assertion`, cookie `CF_Authorization` as fallback. Verified as Cloudflare
  documents it: RS256 signature with the team's keys from
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached; a token with an
  unknown key ID makes the API re-read them, at most every 30 s, so key rotations need no
  restart), issuer `https://<team>.cloudflareaccess.com`, audience = `CF_ACCESS_AUD`,
  expiry and not-before (one minute of clock skew), and optionally `CF_ACCESS_ALLOWED_EMAILS`.
  Refusals are `401` with `WWW-Authenticate: CloudflareAccess` and a JSON body with a
  machine-readable `reason` (`access_token_missing`, `access_token_expired`,
  `access_token_invalid`), or `403` with `access_email_not_allowed`, so the web app can tell
  an expired Access session from other errors.
- `none` (local development only): no authentication; the API logs a warning at startup.

Why the API checks the token although Access sits in front: anything that reaches the
container's port without going through Cloudflare (another process in the container, the host,
the local network) would otherwise drive the API, e.g. push a session branch without the
user's approval.

Exempt, each with its own protection (`AUTH_EXEMPT_ROUTES` in
`apps/api/src/app/auth/authenticator.ts`): `GET /api/health` (no data) and
`POST /api/git/credentials` (session process token) and `POST /api/github/webhook`
(signature, see [PR automation](#pr-automation); session processes are refused there too).
The notification routes (settings, devices, tests, the approval buttons) are not exempt.

**Session processes cannot call the API.** With `PROCESS_ISOLATION=separate-users`, connections
over loopback from a process of the session user (looked up in the kernel's socket table,
`/proc/net/tcp*`) are refused with `403` (`session_process_refused`) except on the routes
sessions need (the credential endpoint, the health check), in either auth mode. This is what
closes the hole in `AUTH_MODE=none` inside the container. Still open with `AUTH_MODE=none`:
every process outside the container that can reach the port (the compose file publishes it on
the host's loopback only) and, in development (`single-user`), session processes themselves,
which run as the same user as the API.

### Request guard

The API has no login of its own and drives an agent with tools, so every HTTP request and
WebSocket upgrade passes a guard (`apps/api/src/app/security`):

- The `Host` header must be a loopback name (`localhost`, `127.0.0.1`, `::1`, `*.localhost`),
  a name in `ALLOWED_HOSTS` or the host of an `ALLOWED_ORIGINS` entry. This stops DNS
  rebinding. **In production set `ALLOWED_HOSTS` to the public host name**, e.g.
  `ALLOWED_HOSTS=crm.example.com`, or every request through the tunnel is refused with 403.
  Names in the preview domain (`PREVIEW_URL`) are never the app's, also not as `*.localhost`;
  the preview gateway answers them before the guard (see
  [Previews](#previews-of-dev-servers)).
- A request with an `Origin` header must come from the same origin (`Origin` host equals
  `Host`) or from `ALLOWED_ORIGINS`; `Origin: null` and preview origins are refused. Browsers send `Origin` on
  every WebSocket upgrade and on cross-site or non-GET requests.
- Without `Origin`, POSTs and WebSocket upgrades are refused only if the browser marks them
  as cross-site (`Sec-Fetch-Site`). Non-browser clients such as curl or the container health
  check work unchanged.
- Request bodies must be `application/json` (415 otherwise), so HTML forms on other sites
  cannot post to the API. The only exception is the image upload (`POST /api/attachments`),
  which takes `image/png`, `image/jpeg`, `image/gif` or `image/webp` bodies and nothing else
  (`RAW_BODY_ROUTES`): forms cannot send these types, and a foreign page's `fetch` with them
  needs a CORS preflight, which the API never answers.

Routes that need another protection are exempted in `REQUEST_GUARD_EXEMPT_ROUTES`: only
`POST /api/github/webhook`, which GitHub calls (no browser headers) and which accepts nothing
but a raw JSON body with a valid signature. The PWA's share target is not one of them: the operating
system's form post (`POST /share-target`, multipart) is taken by the service worker and never
reaches the API (see [Web app (PWA)](#web-app-pwa)); without a service worker the post
finds no route (404).

The web app's pages (everything outside `/api`) carry a Content Security Policy (`APP_CSP` in
`apps/api/src/app/configure-app.ts`): scripts only from the app's own files (the production
build inlines none; critical CSS inlining is off for that), images only from the app, `data:`
and `blob:`, connections (API, WebSocket) and frames only to the app's origin (frames also from the
preview hosts, with `PREVIEW_URL`), no plugins, no
`<base>` elsewhere, and the app itself may not be framed. Styles need `'unsafe-inline'`
because Angular inserts component styles at runtime. The service worker and the manifest need
nothing beyond `worker-src 'self'` and `manifest-src 'self'` (both same-origin). Rendered Markdown (Claude's messages,
plans, shown Markdown files) never loads remote resources either: images other than `data:`
become links (also from raw HTML), and links open in a new tab without referrer. Otherwise
content from a repository or a web page could make Claude write an image URL that sends data
to any server as soon as the message renders.

## Sessions

```
browser ──REST /api/sessions──▶ SessionsController ─┐
   ▲                                                ▼
   └──WebSocket /api/ws──── SessionsGateway ◀── SessionsService ──▶ AgentRunner (Agent SDK query)
                                                    │                     │
                                     SQLite (sessions, usage)    Claude Code process per session
```

- `POST /api/sessions` creates a session in status `preparing` and returns it. Its clones
  (or scratch directory) are created and the setup scripts run (see
  [Repositories and session clones](#repositories-and-session-clones)); then a Claude Code
  process starts through the Agent SDK in streaming-input mode with the prompt. The main
  repository's clone is the working directory, the other clones are additional directories.
  The process stays alive
  for follow-up messages; several sessions run side by side. The process is an internal
  detail: it is closed after `SESSION_IDLE_TIMEOUT_MINUTES` without activity and when the
  server stops, and the next message starts it again with the SDK's resume option.
- SDK messages are mapped to session events (`libs/shared-types/src/lib/session-events.ts`):
  streamed text deltas, complete text blocks, tool calls and results, permission denials,
  notices, errors, turn results with usage, and context usage. The server keeps an event log
  per session while it has a process or subscribers. A client that subscribes gets the whole
  log, or after a reconnect only the events after its last position (`logId` and `seq`), plus
  the text of blocks still streaming; then live events.
- History: conversation events come from Claude Code's transcript (`getSessionMessages`).
  Events the app produces itself (permission decisions, errors, notices, turn results,
  context usage) are stored in the `session_events` table and merged in at their place in
  the transcript. Status changes and text deltas are live-only. The Agent SDK returns
  transcript messages without timestamps, so rebuilt conversation events have `at: null`.
  An unused session's log is released and rebuilt this way when it is opened again.
- Status: `preparing` (clones and setup scripts; messages are refused until it is done),
  `running` (Claude works on a turn), `waiting` (waits for the user, whether or not a process
  is alive; `waitingFor` says for what: `message`, the next message; `permission`, an answer to
  an approval request, question or plan of the running turn; `setup`, a decision about the first
  message after a failed setup script, see below), `finished`
  (ended with "End session", `POST /api/sessions/:id/end` or the `session.end` frame) and
  `failed` (a clone could not be created, or the process could not start or ended with an
  error during a turn). A message to a finished or failed session resumes it, unless its
  directories are gone (failed preparation, removed clones). A turn
  cut off by a server stop is recorded with a notice and the session waits again; on shutdown
  the server waits up to 5 seconds for the Claude Code processes to exit.
- Usage: every result message's tokens (input, output, cache write, cache read) and the SDK's
  theoretical cost in USD are stored per request and model in `usage_records`; the session
  shows the totals. Context window usage is read from Claude Code (no API request) during a
  turn (at most every 5 s, live only) and after each turn (stored), so it survives reloads.
- Approvals: see [Approval requests](#approval-requests).
- Model and permission mode: chosen when the session is created and switchable at any time
  (`PATCH /api/sessions/:id` or the `session.update` frame): a running process switches right
  away (`setModel`, `setPermissionMode`), otherwise the next process starts with it. The models
  are the list Claude Code reports for the account (`GET /api/models`, read through a
  short-lived Claude Code process without prompt, cached for an hour; the aliases default,
  opus, sonnet and haiku if that fails). Modes offered: `default` (ask), `acceptEdits`, `plan`
  and `dontAsk`; `bypassPermissions` and `auto` are never offered or accepted, and every
  session's flag settings disable both (`disableBypassPermissionsMode`, `disableAutoMode`, and
  `useAutoModeDuringPlan: false`), so approvals come from the user and not from a classifier.
  Mode changes Claude Code makes itself (entering plan mode, approving a plan) are taken over
  from its `status`/`init` messages. Changes are logged as `settings.changed` events.
- Queued messages: a message sent while a turn runs (also while it waits for an approval) is
  queued by the app (`message.queued`), not handed to Claude Code, and goes to Claude when the
  turn ends (all queued messages at once; Claude Code may take them as one turn). Until then it
  can be removed (`DELETE /api/sessions/:id/queued-messages/:messageId` or `message.unqueue`).
  Stop, ending the session, a failed process or a server stop withdraw the queue
  (`message.dequeued` with `withdrawn`); the view offers the text again. Claude Code's own queue
  would take messages into the running turn earlier, but the SDK has no public way to remove
  one from it, so the app keeps the queue itself.
- Task list: Claude's task list is shown live from its `TaskCreate`/`TaskUpdate` (and, in
  other Claude Code versions, `TodoWrite`) tool calls, so it is rebuilt with the history. The
  bundled Claude Code offers these tools to SDK sessions only with
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, which every session process gets.
- Plan limits: the 5-hour, weekly and per-model weekly windows of the account come from
  `rate_limit_event` messages of any session and from Claude Code's plan usage request after
  turns; `GET /api/limits` reads them again through a short-lived process when they are unknown
  or older than 5 minutes (the web app asks every 5 minutes), and a later answer drops windows
  it no longer lists. Changes go to all clients as `account.limits`. The header shows them with
  percent, reset time and when they were last updated.
- Integrations: each Claude Code process gets a session token and the API URL for the git
  credential helper, the tools `show_file` (always) and `create_pull_request` (when the
  session has a GitHub repository; both in the in-process MCP server `crm`), a permission rule
  that makes `git push` always ask, and the auto-memory directory of its main repository.
- Session files are read by the API only through `apps/api/src/assets/session-files.cjs`, run
  as the session user: it opens the file, checks the real path of what it opened
  (`/proc/self/fd`) against the session's directories and refuses everything else (symlinks
  or `..` out, absolute paths elsewhere, directories, FIFOs, devices). Approval diffs, `@`
  listings of scratch directories and `show_file` use it; git in clones runs as the session
  user as well.
- Settings: sessions get Claude Code's own system prompt and the user, project and local
  settings, including `CLAUDE.md` files of the working directory and the user's; the managed
  policy `/etc/claude-code/CLAUDE.md` is always loaded.
- MCP servers: sessions get Claude Code's built-in tools and the app's own tools (in-process
  server `crm`) only. Every process runs with `strictMcpConfig` (`--strict-mcp-config`: MCP
  servers only from the app's `mcpServers` option, none from the user's configuration, a
  repository's `.mcp.json`, plugins or agent definitions) and the setting
  `disableClaudeAiConnectors`, so the Claude account's claude.ai connectors (mail, drive,
  calendar, task managers, ...) are neither fetched nor reachable. A repository's own
  `.mcp.json` is not loaded; MCP servers per repository are a later stage.

REST: `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`,
`PATCH /api/sessions/:id`, `POST /api/sessions/:id/messages`,
`DELETE /api/sessions/:id/queued-messages/:messageId`,
`GET /api/sessions/:id/permission-requests`,
`POST /api/sessions/:id/permission-requests/:requestId`, `POST /api/sessions/:id/interrupt`,
`POST /api/sessions/:id/end`, `POST /api/sessions/:id/pending-message/send`,
`POST /api/sessions/:id/setup/rerun`, `POST /api/sessions/:id/repositories/:repositoryId/push`,
`POST /api/sessions/:id/repositories/:repositoryId/pull-requests`,
`POST /api/sessions/:id/pull-requests/refresh`, `GET /api/repositories`,
`GET /api/repositories/:id`, `POST /api/repositories`, `PATCH /api/repositories/:id`,
`POST /api/repositories/:id/fetch`, `POST /api/repositories/:id/github`,
`GET /api/repositories/:id/branches`, `GET /api/github/status`, `GET /api/github/repositories`,
`GET /api/settings`, `PUT /api/settings`, `POST /api/git/credentials` (credential helper only),
`GET /api/models`, `GET /api/limits`, `GET /api/health`, `GET /api/sessions/:id/diff`,
`GET /api/sessions/:id/diff/file`, `GET /api/sessions/:id/files`, `POST /api/attachments`,
`GET /api/attachments/:id`, `GET /api/shown-files/:id`, `GET /api/shown-files/:id/content`,
`GET /api/shown-files/:id/live`, `GET /api/github/references`,
`GET /api/github/references/:owner/:repo/:number`,
`GET /api/sessions/:id/messages/:messageId/context`, `GET /api/notifications`, `PUT /api/notifications/preferences`,
`POST /api/notifications/push-subscriptions`, `POST /api/notifications/push-subscriptions/remove`,
`DELETE /api/notifications/push-subscriptions/:id`, `POST /api/notifications/test`,
`POST /api/notifications/approval-actions`,
`PATCH /api/sessions/:id/pull-requests/:pullRequestId/automation`,
`POST /api/sessions/:id/autofix/stop`, `GET /api/sessions/:id/repositories/:repositoryId/clone-loss`,
`POST /api/sessions/:id/repositories/:repositoryId/discard-clone`, `POST /api/github/webhook`
(GitHub only). WebSocket: `/api/ws` with the versioned protocol in
`libs/shared-types/src/lib/session-events.ts`.

### Diffs

- In the history: every `Edit`, `Write` and `NotebookEdit` gets a `tool.diff` event with the
  change from Claude Code's structured tool result (`structuredPatch`, with the file's line
  numbers), at most 2000 lines. The events are stored, because the transcript the Agent SDK
  returns lacks the structured results; histories from before get a diff rebuilt from the
  tool's input, marked approximate (line numbers count from the changed text). Changes made
  through Bash are not diffed per call; the session diff covers them.
- In approvals: a request for a file change carries the change against the file's current
  content (read as the session user, up to 1 MB, only inside the session's directories;
  otherwise from the input).
- Whole session: `GET /api/sessions/:id/diff` compares every clone, like a pull request, with
  the merge base of `HEAD` and `origin/<base branch>`: the base branch as the clone knows it,
  set when the clone was made from the freshly fetched mirror and moved only by the session's
  own `git fetch`, i.e. what the session merges or rebases from. Changes merged or rebased in
  from the base branch are therefore not shown as the session's. Without a base branch, without
  that ref or without common history it falls back to the commit the session branch started
  at (`startCommit`); the response says what it compared with (`comparison`: commit, basis,
  ref, reason of a fallback) and the changes page shows it. Included: commits of the session,
  uncommitted and staged changes and untracked files that are not ignored, renames, binary
  files. git runs in the clone as the session user, with external diff tools and text
  conversions off and hooks disabled; untracked files are added as intent-to-add entries to a
  temporary copy of the clone's index (in its git directory, removed afterwards; copies left
  by a stopped server are removed after ten minutes), so the clone's index and objects stay
  untouched. File list and patches come from one `git diff --raw --numstat -p -z` run, so they
  cannot be paired wrongly while the session keeps writing, and paths come from `-z` output,
  so any file name works. Limits: 1000 files listed per repository, 3000 diff lines per file
  and 20000 in total; files left out are marked `too_large` or `omitted` and loaded one at a
  time (`GET /api/sessions/:id/diff/file?repositoryId=&path=&oldPath=`, up to 20000 lines).
  The web app shows it on the session's changes page (`/sessions/:id/changes`), unified or
  side by side (kept per browser; unified by default on narrow screens); the component is
  meant for the cleanup dialog too.

### Images, `@` references and shown files

- Images: pasted, dropped or picked in the input (or the new-session form), each uploaded
  right away (`POST /api/attachments`, body = the image; PNG, JPEG, GIF or WebP checked by
  content, at most 5 MB, at most 10 per message) into `FILES_DIR/attachments` (`0600`, API
  user only), and named by the message (`attachmentIds` on `message.send`,
  `POST /api/sessions/:id/messages` and `POST /api/sessions`, also with an empty text). They
  go to Claude Code as base64 image blocks before the text (also for queued messages and a
  first message held back after a failed setup script) and are served at
  `GET /api/attachments/:id` (nosniff, sandboxing CSP). The `attachments` table ties them to
  their message, so reloaded histories show them; uploads no message took are removed after a
  day.
- `@` references: `GET /api/sessions/:id/files?query=` lists the files of all the session's
  directories (in clones `git ls-files` of tracked and untracked, not ignored files; scratch
  directories walked without `.git` and `node_modules`), as the session user, cached 30 s,
  ranked by path fragments, at most 50. The input inserts `@path` (relative to the working
  directory), `@/absolute/path` for other directories, quoted as `@"..."` with spaces. Claude
  Code expands these itself when the message arrives (it reads the files into the turn as
  attachments; checked with the bundled Claude Code for relative and absolute quoted paths).
- `show_file` (path, optional caption): reads the file as the session user, only inside the
  session's directories, and keeps a snapshot (up to 20 MB) in `FILES_DIR/shown`; larger
  files keep only their metadata and are served from the session while it exists
  (`.../live`). It never asks (allowed by rule and in `canUseTool`) and causes no
  notification. A `file.shown` event (stored) puts a card on the tool call; images Claude reads
  (`Read` returning image content) or writes (`Write` of an image file) get thumbnails the same
  way; images made by Bash commands do not, unless Claude shows them. Served at
  `GET /api/shown-files/:id/content`: images, PDFs, HTML and text inline, anything else (and
  `?download=1`) as attachment, always `nosniff` and with a CSP: `sandbox` (an opaque origin
  even when opened directly: no cookies, storage or API of the app; `Origin: null` is refused
  by the request guard), `default-src 'none'` (loads and sends nothing); HTML may run its own
  inline scripts (`sandbox allow-scripts`) and is shown in an `<iframe sandbox="allow-scripts">`;
  PDFs are not sandboxed, because browser PDF viewers do not render sandboxed documents. The
  viewer renders Markdown (sanitized), highlights code (highlight.js, loaded on first use) and
  embeds PDFs. Snapshots and attachments belong to their session (database cascade, and
  removal of files without a row at startup); there is no session deletion yet (cleanup step).

### GitHub references (`#123`)

Typing `#` in the input (session view and new-session form) offers issues and pull requests
of the session's GitHub repositories (in the form: the GitHub repositories chosen there), by
number (prefix) or title words; nothing typed after `#` lists the most recently updated.
`owner/repo#…` searches that repository instead, if the GitHub App's installations can
access it. Sessions without a GitHub repository (scratch, local projects) offer nothing for a
bare `#`. Choosing inserts `#12` for the session's first GitHub repository and
`owner/repo#12` for others. Every reference in the text becomes a chip above the input
(title, state as colour: open, draft, merged, closed; "not found" or "unavailable" when
GitHub cannot answer); its preview has author, labels, branch and size of a pull request, the
start of the description (GitHub Markdown through the Markdown pipe: no remote images), the
link to GitHub (new tab, `noopener noreferrer`) and two choices, off by default: "Give Claude
the comments" and, for pull requests, "Give Claude the diff". The preview opens on hover with
a mouse and on click or tap everywhere (a tap outside closes it), so on a phone the link is
never one accidental tap away. In the history the references of a message are chips in its
text, with the state at sending time; "GitHub context for Claude" below the message shows the
context exactly as Claude got it (loaded when opened). Chips survive reloads, API restarts,
queued and withdrawn messages ("Edit and send again" restores the choices) and a first
message held back by a failed setup script.

- **API**: `GET /api/github/references?query=&repositories=a/b,c/d` (suggestions, at most 20,
  errors per repository), `GET /api/github/references/:owner/:repo/:number` (preview),
  `references` on `message.send`, `POST /api/sessions/:id/messages` and `POST /api/sessions`
  (`token`, `repository`, `number`, `comments`, `diff`; at most 10),
  `GET /api/sessions/:id/messages/:messageId/context`.
- **Names and requests**: repository names are checked against GitHub's naming rules
  (`isRepositoryFullName`) and looked up in the installations' repository list (refreshed at
  most every 15 s for an unknown name) before anything is requested; a name in a message never
  makes the API call another host or path. Tokens are minted per repository with
  `issues: read` + `pull_requests: read` (and `contents: read` only for a pull request's
  diff, which GitHub renders only for tokens that can read the code); nothing reaches session
  processes.
- **GitHub requests** (cached 60 s each): the 100 most recently updated issues and pull
  requests per repository, the search API for title words, single items (`/issues/:n`, plus
  `/pulls/:n` for pull requests), comments (the latest 100 of issue comments and of review
  comments, plus reviews), the diff (`application/vnd.github.diff`; when GitHub refuses it as
  too large, per-file patches of up to 300 files).
- **Limits** (`CONTEXT_LIMITS`): description 8,000 characters, the latest 50 comments, 4,000
  characters per comment and 40,000 for all comments of a reference, diff 60,000 characters,
  150,000 for the whole context of a message (later references are cut first). Whatever is
  cut is said in the context (for Claude) and in the reference's `notes` (shown in the chip's
  preview).
- **Failures**: a reference that cannot be resolved (not found, no access, rate limit, GitHub
  unreachable, no answer within 20 s) does not stop the message: its chip says why and Claude
  is told that its content is missing and not to guess it. Comments or a diff that fail to load
  are reported the same way.
- **Storage**: `message_contexts` (one row per message with references or context): the
  resolved references, the context text Claude got and its transcript UUID. The history adds
  references to `user.message` (`references`, `contextLength`) from it; `message.queued`
  events carry them as well.

**Untrusted content.** Issue and pull request text and comments are written by anyone who can
open an issue, so they are data for Claude, never instructions, and must not be able to use
Claude Code's own input handling. The context goes to Claude Code as a user message of its own,
right before the user's message (`sdkUserMessages` in `apps/api/src/app/agent/sdk-agent-runner.ts`):

- `client_composed: true`: Claude Code delivers the text as written: no `@path` expansion, no
  slash command;
- `shouldQuery: false`: it starts no turn; Claude Code merges it into the next message, the
  user's own, whose text keeps `@` expansion and the context Claude Code attaches at the start
  of a turn (nested `CLAUDE.md`, skill listing, reminders), which `client_composed` would
  skip for a turn it starts. Claude Code answers it with a result of zero turns, which the app
  does not count as the end of a turn;
- `isSynthetic: true`: Claude Code prefixes it with `[MESSAGE FROM NON-USER SOURCE - NOT USER
INPUT]` and leaves it out of the conversation `getSessionMessages` returns (the app also
  drops it by its UUID when rebuilding a history).

Inside, `formatUntrustedContext` (`apps/api/src/app/agent/untrusted-context.ts`) says where the
content comes from, that the user did not write it and that instructions in it are not to be
followed, and wraps each item in `<untrusted-content-<random> ref=… author=… url=…>`: the tag
name ends with 16 random hex characters per message, so content cannot close it early; text
that imitates the wrapper or `<system…>` markup gets a backslash after its `<`. Checked with the
bundled Claude Code 2.1.322 (a local fake Messages API recording what Claude Code sends, and a
real session): only the last text block of a message and its `pasted_content` are `@`-expanded
(so `pasted_content` is not an option), a context message as above is never expanded or run,
the user's own `@README.md` after it is, and the turn-start context is still attached.

**For the PR automation** (and anything else that gives Claude outside content):
`SessionsService.sendMessage(sessionId, { text, origin: 'app', untrusted, references })` sends
a message with untrusted context (`UntrustedContext`: `source`, `purpose`, items with
attributes and content), queues it behind a running turn or resumes the session like a user
message, stores it like one (`origin: 'app'` on the `user.message`) and keeps messages in the
order they arrived. Text of origin `app` is delivered as typed and must contain no `@` and not
start with `/`: put variable content (check names, logs, comments) into `untrusted`.

### Approval requests

Every tool use that Claude Code does not allow on its own (by a rule or the permission mode)
reaches the session's `canUseTool` and becomes a pending request: a `permission.request` event
(stored, so a reloaded history shows it) with the tool, its input and a readable summary in the
view (command, file and change, URL, …), `gitPushes` for `git push` commands and `pullRequest`
for `create_pull_request`. Every client of the session shows it as a card above the input (also
on phones) and the session is `waiting` for `permission` meanwhile. The first answer counts
(`permission.respond` frame, or `POST /api/sessions/:id/permission-requests/:requestId` for
answers without WebSocket, e.g. from a notification later); it is logged as
`permission.resolved` for all clients. A second answer changes nothing and gets the earlier
resolution back (`alreadyResolved`); session processes cannot call these routes (see
[Authentication](#authentication)).

- Kinds: `tool` (allow once, allow for this session, deny with an optional message to Claude:
  without a message the turn stops and Claude waits, with one Claude continues with it),
  `question` (Claude's `AskUserQuestion`: options, multi-select and own words; the answers go
  back as `answers` keyed by question text, multi-select labels joined with `, `), `plan`
  (`ExitPlanMode` in plan mode: the plan as Markdown; approve into `default` or `acceptEdits`,
  which is applied as a session `setMode` update, or keep planning with feedback).
- "Allow for this session" is offered only from Claude Code's own suggestions for the request,
  rewritten to the destination `session` (never to settings files): allow rules (not for all
  Bash commands, not for prefixes covering `git push`, not for the app's tools) and
  directories. It never switches the permission mode (Claude Code's `setMode` suggestions, e.g.
  "accept edits" for a file change, are dropped): the mode changes only through the mode control
  and by approving a plan. It is never offered for pushes, pull requests, questions, plans
  or when Claude Code says not to (`suppressAlwaysAllowRule`): each push and each pull request
  needs its own approval (see [Push and pull requests](#push-and-pull-requests)). Rules and
  directories allowed for the session are given to every later Claude Code process of the
  session (`allowedTools`, additional directories), so they hold until the session ends.
- A request never stays pending without a process waiting for it: it is cancelled (resolved
  as `deny` with `cause`) when its abort signal fires or the user stops the turn
  (`interrupted`), the session is ended (`ended`), the process exits (`process_exit`), or the
  server stops (`restart`; after a crash the next start closes requests left open). Claude
  Code's own permission prompts have no deadline (`dialogExpiry: never` is set as well), so a
  request waits for the user as long as the process lives; the idle timeout does not apply
  while one is pending.

## Previews of dev servers

Claude starts a dev server in its session (in the background, in the session's directory) and
makes it reachable for the user with the tool `expose_port` (port, name). The user opens the
running app in the browser, with hot reload, as if it ran locally: every preview gets a host
name of its own, so absolute asset paths and hot-reload WebSockets work unchanged.

- **Addresses**: `<session slug>-<port>.<preview domain>`, from `PREVIEW_URL` (e.g.
  `https://preview.example.com` gives `https://fix-login-k3x9q2-5173.preview.example.com`;
  `npm start` uses `http://preview.localhost:3000`, which browsers resolve to loopback). Slugs
  are unique, lowercase `[a-z0-9-]` with a random part, and ports have no dash, so labels are
  valid DNS labels (at most 53 characters) and never collide between sessions. A port is
  exposed by at most one session at a time. Without `PREVIEW_URL` previews are off and Claude
  does not get the tools.
- **Tools** (app's MCP server `crm`, no approval, the owner's decision): `expose_port` checks
  the port and returns the preview URL; exposing a port again renames the preview;
  `stop_preview` (port) ends it. Refused: the API's own port, ports another user listens on
  (root, the API), ports bound to other addresses than loopback or `0.0.0.0`/`::`, a port
  exposed by another session, more than 10 previews per session. A port nothing listens on
  yet is accepted (the preview waits for it). Claude cannot open the preview URL itself (see
  below) and tests on `localhost:<port>`.
- **Session view**: running previews in the header with state (running; not reachable, with
  the reason, e.g. "Nothing listens on port 5173"; stopped, checked every 3 s from the
  kernel's socket table), a link (new tab, no opener, no referrer), Embed and Stop; the
  history shows the same card where Claude exposed the port, and notes stopped previews
  (`preview.exposed`, `preview.stopped`, stored).
- **Stop** ends the forwarding (also open WebSockets); the dev server keeps running, Claude
  can expose it again. `POST /api/sessions/:id/previews/:previewId/stop`.
- **Session end** (End session, autoclose through `DevServers.stopSession`, later the cleanup)
  stops all its previews and, with `PROCESS_ISOLATION=separate-users`, the processes that
  listen on their ports: a helper run as the session user (`stop-listeners.cjs`) finds them
  by the listening socket's inode in its own processes' `/proc/<pid>/fd` and sends SIGTERM,
  SIGKILL after 5 s. Only listeners of the session user can be found and signalled. Which
  session started a process cannot be told (all sessions share the user `claude`), so this is
  the process behind the exposed port, whoever started it. In `single-user` development
  nothing is killed: the listener could be any program of the developer's. Dev servers Claude
  started but never exposed are not found; they end with the Claude Code process if they ran
  as its background tasks.
- **No automatic detection** of newly listening ports: the socket table shows a listener's
  owner, but all sessions run as the same user, and which process (and so which session)
  holds a socket is only visible in `/proc/<pid>/fd`, which the API (another user, without
  `CAP_SYS_PTRACE`) cannot read. A port cannot be attributed to the right session reliably,
  so previews come only from `expose_port`.

### The proxy

The API forwards preview hosts itself (Node's `http`, no proxy library: the parts that need
care — checking every upstream connection, header rules, upgrades — are what a library would
not do, and streaming is `pipe` with backpressure). A gateway in front of the HTTP server
takes every request and WebSocket upgrade whose `Host` lies in the preview domain before
Express or the WebSocket server see it: preview hosts serve nothing of the app (no `/api`,
no app shell, no `/api/ws`; those paths go to the dev server), and the app's host serves no
preview. Unknown names in the preview domain (also deeper ones and the domain itself) get a
plain 404 page, stopped previews 410.

- **Upstream**: only `127.0.0.1`/`::1` at the exposed port. Before a connection is used, the
  socket that accepted it is looked up in `/proc/net/tcp*` and must belong to the session user
  (`separate-users`) or to the API's user (`single-user`), whatever listened when the port
  was exposed; the API's own port is always refused. With separate users the API (`crm`)
  and root listeners can never be reached through a preview. Not enforceable: which session's
  process listens (one user for all sessions); in `single-user` development any service of
  the developer's user on loopback could be exposed (never the API's port).
- **Headers to the dev server**: `Host: localhost:<port>`; `Origin` and `Referer` of the
  preview itself become `http://localhost:<port>` (host and CSRF checks of Vite, webpack,
  Next.js and others pass as locally); a foreign `Origin` is passed on as it is; any other
  `Referer` (the app's page that embeds the preview) is dropped. Dropped: `Cf-*` (the Access
  token `Cf-Access-Jwt-Assertion`, the identity, client IP), `X-Forwarded-*`, `Forwarded`,
  `X-Real-IP`, `True-Client-IP`, `CDN-Loop`, hop-by-hop headers, and the cookies
  `CF_Authorization`, `CF_*`, `__cf*`.
- **Headers to the browser**: `Location` to `localhost:<port>` points back to the preview;
  `Set-Cookie` loses its `Domain` attribute (cookies stay host-only on the preview host; a
  preview cannot set cookies for the parent domain through its responses).
- **Unavailable dev server**: refused connection → 502 page "The dev server is not running"
  that reloads every 5 s (navigations) or `Retry-After` (other requests); no connection within
  10 s → 504; no answer within 120 s → 504; the dev server closing the connection before an
  answer → 502. After the answer started, a broken connection ends the response. The pages
  are the app's own (no scripts, `default-src 'none'`, `no-store`).
- **WebSockets** are forwarded with the same rules, then bytes both ways. Upgrades whose
  `Origin` is not a preview host (any preview: a front end may talk to its back end on another
  port) are refused with 403, so other sites cannot open the dev servers' hot-reload sockets;
  clients without `Origin` are not browsers.

### Previews and the app's security

A preview serves what Claude or a repository wrote, in the owner's browser, on a host next to
the app's. It is treated as a hostile page:

- **Calling the API**: a preview is another origin than the app. Its requests to the app
  carry `Origin: <preview>`, which the request guard refuses (403) for every HTTP request and
  WebSocket upgrade, also when the browser sends the app's cookies along (the app and
  `*.preview.example.com` are the same _site_, so `SameSite=Lax` cookies are sent on
  same-site requests); preview origins are refused even if listed in `ALLOWED_ORIGINS`, and
  the configuration refuses app hosts inside the preview domain. Requests without `Origin`
  (`<img>`, `<script>`) are GETs whose answers the browser does not hand to the page.
  Preview host names are refused by the request guard as the app's host (a second line
  behind the gateway, which matters for `*.localhost`).
- **Cookies and storage**: Cloudflare Access sets `CF_Authorization` per application host
  name, host-only, by default `HttpOnly`, `Secure`, `SameSite=Lax`. The app's cookie (on
  `crm.example.com`) is neither readable by a preview nor sent to preview hosts; the proxy
  removes Access cookies and headers before the dev server, so neither the dev server nor its
  server-side code sees a token. Storage, IndexedDB and the service worker are per origin:
  a preview has its own, and cannot register a service worker for the app's scope.
- **The preview's own token**: previews need an Access application of their own, with its own
  audience (`PREVIEW_ACCESS_AUD`), which the API never accepts (it checks `CF_ACCESS_AUD`),
  and the preview gateway accepts only that audience. Even a preview token that leaked
  (a page reading a non-`HttpOnly` cookie and sending it away) cannot drive the API; it
  could open other previews until it expires. The app refuses to start when
  `PREVIEW_ACCESS_AUD` is missing or shares a tag with `CF_ACCESS_AUD`, and if Access issues
  the app's audience on preview hosts (one application for both), every preview request is
  refused. Remaining: a preview can set cookies for the parent domain from script
  (`document.cookie`, `Domain=example.com`), e.g. a bogus `CF_Authorization`; that can
  disturb the owner's sign-in (the app shows "sign in again"), not act as the owner. A
  separate registrable domain for previews removes even that, at the price of embedding
  (cross-site frames do not get `SameSite=Lax` cookies).
- **Embedding**: the app's CSP allows frames from `'self'` and exactly the preview hosts
  (`frame-src 'self' https://*.preview.example.com`); the app itself still may not be framed
  (`frame-ancestors 'none'`), also not by a preview. The frame is
  `sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"`,
  `referrerpolicy="no-referrer"`, `allow=""`. `allow-same-origin` gives the preview _its own_
  origin (dev servers need storage, cookies and their WebSocket; without it the origin would
  be opaque, `Origin: null`); it cannot reach the app's because the hosts differ (Chrome's
  console warning about the combination concerns same-origin frames). Without
  `allow-top-navigation` it cannot navigate the app's window; popups stay sandboxed. What it
  breaks: links with `target=_top` and OAuth redirects of the previewed app (use New tab),
  camera, microphone and other permission policies. Behind Access, a preview host the
  browser has no cookie for yet shows nothing in the frame (the Access login cannot run in a
  frame): open it in a new tab once.
- **Session processes** cannot open previews (refused by peer user like the management API,
  in either auth mode) and cannot call the stop route; they expose only through their own
  tool.

Checked in a browser (Chromium, app on `crm.localhost`, previews on
`*.preview.crm.localhost`, i.e. same site as in production) with a hostile page served
through a preview, directly and embedded: `fetch` of the app's API with credentials blocked
(403 from the guard, CORS), a no-cors POST refused (403), `/api/ws` refused (403), the app's
cookie and `localStorage` invisible, registering a service worker for the app's scope
refused (SecurityError), framing the app blocked (`frame-ancestors`), and, embedded,
`parent.document`, `parent.localStorage` and `top.location` refused.

### Setting it up at deployment

1. **DNS and tunnel**: a wildcard route for the preview domain in the Cloudflare Tunnel, e.g.
   public hostname `*.preview.example.com` → `http://localhost:8080` (the app's one port; the
   tunnel keeps the `Host` header), and the DNS record `*.preview` as CNAME to the tunnel
   (`<tunnel id>.cfargotunnel.com`, proxied). No further published ports.
2. **Certificate**: Cloudflare's Universal SSL covers `example.com` and `*.example.com`, not
   `*.preview.example.com`; a second-level wildcard needs an Advanced Certificate (or choose a
   first-level preview domain, e.g. `PREVIEW_URL=https://preview-example.com`, a separate zone).
3. **Access**: a second self-hosted Access application for `*.preview.example.com` with the
   same policy (the owner's Google login), cookie settings: HTTP Only on (default), SameSite
   Lax (the default; the embedded frame is same-site with the app). Its Application Audience
   tag goes into `PREVIEW_ACCESS_AUD`. Do not add the preview hosts to the app's application.
4. **Variables**: `PREVIEW_URL=https://preview.example.com`, `PREVIEW_ACCESS_AUD=<tag>`; keep
   `ALLOWED_HOSTS` the app's host only (the preview domain must not be in it).

## Notifications

Sessions run unattended, so the API reports what needs the user, over two channels, each
switchable per event on the Settings page (stored in `app_settings`):

| Event                         | When                                                                               | Withdrawn when                           |
| ----------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| Claude needs you              | an approval request, a question or a plan to review                                | it is answered or cancelled, anywhere    |
| Turn finished                 | a turn ended and Claude waits for the next message (not after Stop or a denial)    | the next turn starts or the session ends |
| Session hangs                 | a running turn without any event for `SESSION_STALL_MINUTES` (once per stall)      | activity resumes or the turn ends        |
| Session failed                | the session failed, or a setup script failed and the first message is held back    | the session continues                    |
| Autofix gave up               | the PR automation reached its attempt limit (reported by the PR automation)        | –                                        |
| Pull request merged or closed | a pull request of the session was merged or closed (reported by the PR automation) | –                                        |

Ending a session ("End session") notifies nobody. Notifications carry the session title and
its repositories, approvals the action and the command or file path (shortened, relative to
the clone), questions the first question; a tap opens the session.

**Nothing is sent about a session that is in front of the user.** Every window of the web app
reports over the WebSocket which session it shows and whether the user is active there
(`presence` frames: page visible and focused, input within the last 5 minutes), repeated every
30 seconds; the API counts a report for 75 seconds (a phone put away stops repeating it). A
subscription alone does not count.

**Web Push** (`apps/api/src/app/notifications/web-push.channel.ts`, library `web-push`): every
browser or device that turned notifications on (Settings page, on a click; the permission
prompt needs a user gesture) is stored in `push_subscriptions`. Messages are encrypted for each
device (RFC 8291) and signed with the server's VAPID key (RFC 8292). The VAPID keys are
generated on the first start into `DB_DIR/vapid-keys.json` (mode `0600` in the API's `0700`
data directory; a looser mode is corrected at startup) or taken from `VAPID_PRIVATE_KEY_FILE` /
`CRM_SECRET_VAPID_PRIVATE_KEY`; the private key is never returned by the API, logged or given
to other processes. Changing the keys means turning notifications on again on each device.
Subscriptions the push service reports gone (404, 410) are removed. Each notification has a
tag; a later one with the same tag replaces it, and a withdrawal closes it on the device (sent
with the same `Topic`, so a push service still holding the notification for an offline device
replaces it). Apple's push service gets no withdrawals: Safari requires every push to show a
notification and revokes subscriptions otherwise, so on iPhone and iPad a notification that
is no longer current stays until it is dismissed or tapped (the session then shows the
current state). On iOS and iPadOS Web Push works only in the app added to the Home Screen;
the Settings page says so in Safari.

**Allow and Deny in the notification**: approval notifications of tool uses offer "Allow
once" and "Deny" where the platform shows buttons (not on iOS). The service worker sends the
answer as an ordinary request of the app to `POST /api/notifications/approval-actions`
(session, request, `allow` or `deny`), with the browser's cookies: the request passes the
Cloudflare Access check and the request guard like every other one, and the notification
carries no token that would let anyone holding it answer. The route answers only that pending
request of that session: Allow is allow once (never "for this session", never a mode change),
Deny is a denial without message (the turn stops). A request answered or cancelled before is
left as it is (`already_resolved`, and the notification says so). Pushes that update more than
the session branch (force, delete, other branches, everything) get no Allow button (and the
route refuses Allow for them): their warnings do not fit a notification. If the answer does not
get through (expired Access session, offline, server error), a notification says "Not
allowed: still waiting" and the session opens, through the Access login if needed, with the
request still pending.

**ntfy**: with `NTFY_URL` and `NTFY_TOPIC` the API publishes to that topic (JSON publishing,
`Authorization: Bearer <token>`). The token is required (the API refuses to start without
`NTFY_TOKEN_FILE` or `CRM_SECRET_NTFY_TOKEN`), read once at startup and kept only in memory:
never in the image, the database, logs, API responses or the environment of session
processes (`CRM_SECRET_*` is removed from child environments; the file is checked by the
entrypoint like the GitHub key). The Settings page shows server and topic read-only and
whether a token is set. Messages carry title, details, priority (high for approvals) and, with
`PUBLIC_URL`, a click link to the session. ntfy gets no Allow/Deny buttons: they would have to
call the API without the browser's Access session. Each notification has an ntfy sequence ID
derived from its tag; withdrawing it deletes it in the ntfy apps
(`DELETE /<topic>/<sequence ID>`, ntfy 2.15 or later; older servers ignore it).

"Send test notification" exists per channel; a refused token is reported with ntfy's answer
(e.g. `HTTP 401: unauthorized`), never with the token.

**For the PR automation**: `NotificationsService` (exported by `NotificationsModule`) has
`notifyAutofixGaveUp(sessionId, pullRequest, attempts, reason)` and
`notifyPullRequestClosed(sessionId, pullRequest, note)` (merged or closed by
`pullRequest.state`; `note` says what autoclose did, e.g. that a clone was kept); preferences,
presence and channels apply as for the other events. The PR automation sends each once per
pull request.

## Web app (PWA)

The web app is an installable PWA (`apps/web/public/manifest.webmanifest`, icons in
`apps/web/public/icons`, made from `assets/icon/*.svg`) with a service worker
(`apps/web/src/sw/`, built by `apps/web/scripts/build-service-worker.mjs` into `/sw.js`; the
web build runs it first):

- **Offline shell**: the app's page is fetched from the network first and cached; the built
  files are cached as they load (the app preloads all pages after the start). Offline, after
  4 seconds without an answer, or when the tunnel in front answers with an error because the
  server is down (502, 503, 504, 52x, 530), the app starts from the cache. The session list
  shows the last list this browser loaded, marked as stale with its time, and reloads when
  the connection is back. `/api` is never cached by the service worker, and other origins
  (previews of dev servers among them) are never handled. Only the app's own
  page is cached as shell: redirected answers, non-HTML answers and pages that are not the app
  (e.g. the Access login page) are never stored.
- **Expired Cloudflare Access session**: API calls then end at the Access login (a redirect
  that fetch reports as a network error, or a `401`/`403` from Access or the API's own token
  check). The app then asks the health endpoint without following redirects; a redirect or a
  `401`/`403` there comes from Access, so it shows "Your sign-in has expired" with "Sign in
  again", a full navigation that goes through the Access login and back. A WebSocket that
  cannot connect triggers the same check. Navigations pass redirects to the browser
  untouched. With `AUTH_MODE=none` none of this triggers.
- **Badge**: the app icon shows the number of sessions blocked on the user: an open
  approval request, question or plan, or a failed setup script holding the first message
  back (`needsUser` in the shared types). A session whose turn finished and that waits for
  the next message does not count. Set by the open app and by every push message (Badging
  API, installed app).
- **App shortcuts**: "New session" (`/?new=1`, the cursor goes into the form) and "Waiting
  sessions" (`/?waiting=1`): the list filtered to the sessions that need the user ("Needs
  you", the same sessions the badge counts).
- **Share target**: links, text and images shared to the installed app become a new session's
  prompt and images: the service worker takes the operating system's form post
  (`POST /share-target`, multipart) itself, keeps it in the Cache API (dropped after a day if
  unused) and opens `/?share=<id>`; the new-session form is filled in and the images are
  uploaded like attached ones (`POST /api/attachments`). The API never sees the form post,
  so its request guard stays JSON-only.
- The manifest is loaded with credentials (`crossorigin="use-credentials"`), as Cloudflare
  Access needs its cookie for it.

## Repositories and session clones

```
WORKSPACE_DIR/repos/acme/app                          mirror (bare), cloned once, then fetched
WORKSPACE_DIR/repos/local/new-tool                    local project: mirror without remote
WORKSPACE_DIR/sessions/fix-login-k3x9q2/acme/app      session A's clone, branch claude/fix-login-k3x9q2
WORKSPACE_DIR/sessions/add-export-7pd2mz/acme/app     session B's clone of the same repository
WORKSPACE_DIR/sessions/add-export-7pd2mz/acme/lib     session B's second repository
WORKSPACE_DIR/scratch/quick-question-p0a1b2           session C: scratch directory, no git
```

Each repository has one **mirror**: a bare repository that keeps the remote's branches as its
own branches and its tags; it is cloned from the network once and then only fetched. Nobody
works in it. Each session gets, per repository, its **own complete clone** of the mirror
(`git clone --local`): the objects are hardlinked, so a clone costs almost no disk space and
no network, but refs, stash, tags, config, hooks and index belong to the clone alone. No
alternates are used, so the mirror's `git gc` cannot break a clone. `origin` of the clone
points to the real remote (fetch and push go there), its `origin/*` branches match the
freshly fetched mirror, and the branch `claude/<slug>` is checked out at the base commit,
without upstream. A session's directories sit together in `sessions/<slug>/`, so discarding a
session is deleting that directory.

Hardlinks need one filesystem: `repos/`, `sessions/` and `scratch/` are subdirectories of
`WORKSPACE_DIR` (one volume in the container). The API warns at startup if they are on
different filesystems; git then copies the objects, which is correct but slow and large.

**Local projects** (`local/<name>`, created on the Repositories page or with "New project" in
the new-session form) are repositories without remote. Their mirror starts with an empty
commit on `main` (authored with the configured commit identity), so every session has a real
base commit and parallel first sessions share history; sessions clone it like any other
repository, with the mirror as `origin`. A session's work reaches later
sessions only when it is brought into the project's `main`: `GitService.fastForwardMirror`
fast-forwards `main` of the mirror to the session branch (merge `main` into the session
branch first if it moved on); the cleanup step will offer that as "merge". Pushes from session
clones into the mirror may only fast-forward and never delete branches. Attaching a GitHub
remote later turns the project into a normal repository without moving data: "Put on GitHub"
on the Repositories page (`POST /api/repositories/:id/github`) sets the mirror's remote, pushes
its branches and tags, and points the existing session clones' `origin` there (see
[GitHub](#github)).

**Scratch sessions** ("No repository") get an empty directory of their own without git.

### Data model

- `repositories`: owner, name, clone URL (`null` for local projects), default branch (as last
  fetched), path of the mirror, setup script, clone/fetch times and last error;
  `github_repository_id` and `github_installation_id` for repositories registered from GitHub
  (fetched, cloned and pushed with installation tokens).
- `sessions`: as before plus the `slug` and the `pending_message` (the first message while it
  has not been sent to Claude).
- `session_directories`: the session's directories in order; position 0 is the working
  directory, the others are additional directories. `kind` is `clone` (with `repository_id`,
  `branch`, `base_branch`, `base_commit` — the commit the branch started at, the fallback
  comparison point of the session diff — and `setup_status`), `scratch`, or `directory` (sessions from before session
  clones). `state` is `pending`, `ready`, `failed` or `removed`. This table is the only source
  of a session's directories (the former `sessions.cwd` was migrated into it).
  `pushed_commit`/`pushed_at`: what was last pushed of the session branch (by button, or seen
  after an approved push by Claude).
- `pull_requests`: per session clone (session and repository) the pull requests created by
  button or by Claude: number, URL, title, state (`open`, `closed`, `merged`), draft, head and
  base branch, creator (`user`/`claude`), opened/closed/merged times and when the state was
  last read from GitHub (open ones at most once a minute when the session is opened), the
  head commit, and the PR automation per pull request: `autofix`, `autoclose`, attempts and
  limit, when the limit stopped a run, the head commit whose failed checks were handled, the
  time after which reviews are new, the last run and what triggered it, whether a run is
  going on, when the merge or close was handled.
- `sessions.autoclosed_at`: when autoclose ended the session; clones still `ready`
  afterwards were kept because they hold work that is not on GitHub.
- `webhook_deliveries`: IDs of processed webhook deliveries (a week), so redeliveries do
  nothing.
- `app_settings`: settings edited in the UI (key, JSON value): the commit identity, and under
  `notifications` which events go to which channel.
- `message_contexts`: per user message with GitHub references or untrusted context: the
  references as resolved, the context text Claude got, the transcript UUID of the context
  message and the origin (`user`, or `app` for messages the app composed).
- `push_subscriptions`: the devices that receive Web Push (endpoint, keys, readable label,
  last success or error); removed when the push service reports them gone.

### How a session gets its directories

1. `POST /api/sessions` with `repositories: [{ repositoryId, baseBranch? }, …]` (the first is
   the main repository), `newProject: { name }` (creates the local project and makes it the
   main repository), or `scratch: true`. The request is validated and a slug is chosen:
   readable part from the title or prompt (`a-z0-9-`, at most 40 characters) plus 6 random
   characters (`crypto.randomInt`), unique among sessions and directories.
2. Per repository, in parallel: the mirror is created on first use, otherwise fetched. If the
   fetch fails but a mirror exists, the session starts from the last fetched state and a
   warning names its age. Then the session clone is created from the base branch (default
   branch unless chosen). Events `prepare.progress` report each step.
3. If any clone cannot be created (no mirror, unknown base branch, …), the session's other
   directories are removed again and the session is `failed` with an error naming the
   repository. A preparation cut off by a server stop is rolled back the same way on the next
   start.
4. The setup scripts run one after another in their clones (`bash -e -o pipefail`, with
   `CRM_SESSION_ID`, `CRM_SESSION_SLUG`, `CRM_REPOSITORY`, `CRM_CLONE`, without the app's
   secrets), with `SETUP_SCRIPT_TIMEOUT_MINUTES`. Output streams as `setup.output` events
   (stored, at most 256 KB per script; the end is kept in `setup.result`).
5. If all setup scripts succeeded, the prompt goes to Claude and the status becomes
   `running`. If one failed or timed out, the session waits with the prompt pending
   (`pendingMessage`); Claude gets nothing until the user sends the prompt anyway
   (`pending.send`), runs the failed scripts again (`setup.rerun`; on success the prompt is
   sent) or ends the session. Ending the session during the preparation stops the setup
   script and does not send the prompt.

`GET /api/repositories` lists each repository with its session clones from the database and
from `sessions/<slug>/<owner>/<repo>` on disk. Clones without a session are marked orphaned,
clones a session expects but that are gone are marked missing; clones of unregistered
repositories and unused scratch directories are listed as stray. Removing a session clone
(`GitService.removeSessionClone`) is used by autoclose (see [PR automation](#pr-automation));
fast-forwarding a local project exists for the cleanup step, without UI yet.

Repositories registered from GitHub are cloned and fetched with installation tokens (see
[GitHub](#github)). Repositories registered by clone URL use whatever git credentials the
API's environment has (SSH key, credential helper), so public HTTPS URLs and local paths work
out of the box. Clone URLs are validated (https, ssh, scp-like `git@host:owner/repo` or an
absolute local path; no credentials in the URL, no other transports); git always runs with
argument arrays and `--` before user values, without prompts and without repository hooks.

### Isolation and concurrency

Several sessions may work in the same repository at the same time without seeing each other:

- **Nothing is shared but immutable objects.** Each session clone has its own refs, stash,
  tags, config, hooks, index and working tree; a stash, tag, config change, hook, branch
  operation, `git gc --prune=now` or `git worktree add` in one session leaves the other
  sessions and the mirror byte-for-byte unchanged (tested with real repositories). Object
  files are never modified in place by git, so hardlinks are safe; deleting a clone or
  garbage-collecting the mirror leaves the other copies intact.
- **The mirror is only written by the API.** Writes to one mirror (clone, fetch, creating a
  session clone from it, fast-forwarding a local project) run one at a time in the API;
  mirrors of different repositories do not wait for each other, and sessions started at the
  same time share one fetch.
- **Limits:** pushes from a session go to the remote (or, for a local project, to its mirror,
  where only fast-forwards are accepted), so a session can still push to a branch others use;
  the global `CLAUDE.md` allows pushing only the session branch after the user approved. The
  serialization is per API process; two API instances on the same workspace are not
  supported. Joining a running fetch can miss a commit pushed after that fetch started.
- **Auto-memory is per repository**, not per session clone: Claude Code would keep it per
  working directory; the app sets `autoMemoryDirectory` to `MEMORY_DIR/<repository id>`
  (outside the clones), so all sessions of a repository share one memory, also after a local
  project was put on GitHub. Scratch sessions keep Claude Code's default.

## GitHub

The app talks to GitHub through its own GitHub App. Without configuration it still starts and
works with local projects and repositories registered by clone URL; the Settings page says
that GitHub is not configured and why.

### Configuration

| Setting                    | How                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| App ID                     | `GITHUB_APP_ID` (plain configuration)                                                                                      |
| Private key                | `GITHUB_APP_PRIVATE_KEY_FILE`: path of the PEM file, mounted as secret (see [Container](#github-app-key-in-the-container)) |
| Private key, alternatively | `CRM_SECRET_GITHUB_APP_PRIVATE_KEY`: the PEM itself                                                                        |

The key is never part of the image, the database, logs or the configuration object; it is read
once at startup and never given to child processes, and neither are app JWTs.

Permissions the app needs (repository permissions):

| Permission     | Access     | Used for                                                                |
| -------------- | ---------- | ----------------------------------------------------------------------- |
| Metadata       | read       | listing the installations' repositories                                 |
| Contents       | read/write | cloning, fetching and pushing; reading refs when creating pull requests |
| Pull requests  | read/write | creating pull requests and reading their state                          |
| Workflows      | read/write | pushing commits that change `.github/workflows` (only then requested)   |
| Administration | read/write | creating repositories for local projects (organizations)                |
| Issues         | read       | `#` references: issues, comments, search                                |

Checks, Commit statuses and Actions (read) are for the PR automation (check runs and
statuses of a pull request's head commit, logs of failed GitHub Actions jobs). Install the app
on your account and
on organizations and choose the repositories there; the Settings page lists the
installations with their repository counts and links to install the app on further accounts.

### Repositories and tokens

`GET /api/github/repositories?query=&page=&perPage=` lists every repository the installations
can access, across the personal account and organizations (searchable, paginated, cached for a
minute). Choosing one in the new-session form or on the Repositories page registers it
(`POST /api/repositories` with `githubRepositoryId`, idempotent) and clones its mirror; later
sessions only fetch.

The client is plain `fetch` (`apps/api/src/app/github`): it follows `Link` pagination, waits
out short rate limits and reports longer ones with the time to retry, and reports GitHub as
unreachable after one retry. A session on a repository that is cloned already still starts
when GitHub is unreachable, from the last fetched state, with a warning.

Installation tokens are minted for exactly one repository and the permissions of the
operation, reused for at most ten minutes, and given to git only through the environment of
one command (`GIT_CONFIG_*`), never through arguments, git config, remote URLs, the database
or logs:

| Operation                                 | Token                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| listing an installation's repositories    | `metadata: read`, whole installation                                         |
| clone and fetch of a mirror               | `contents: read`                                                             |
| push by button                            | `contents: write` (+ `workflows: write` if workflow files changed)           |
| create / read a pull request              | `pull_requests: write` + `contents: read` / `pull_requests: read`            |
| credential helper, normally               | `contents: read`                                                             |
| credential helper, approved push          | `contents: write` (+ `workflows`), fresh, revoked when the push ends         |
| create a repository                       | `administration: write`, fresh, revoked afterwards                           |
| `#` references: issues, comments          | `issues: read` + `pull_requests: read`                                       |
| `#` references: a pull request's diff     | `issues: read` + `pull_requests: read` + `contents: read`                    |
| PR automation: reading state and feedback | `metadata`, `checks`, `statuses`, `pull_requests`, `actions`, `issues`: read |

If the installation of a repository changed (app reinstalled), the current one is looked up
and stored.

### Commit identity

Commits in session clones are made as the user, not as the app: the git author name and email
are app settings (Settings page, `PUT /api/settings`), written into every session clone
(`user.name`, `user.email`, `user.useConfigOnly`) and into existing clones when they change.
While they are not set, sessions with repositories and new local projects are refused with a
message pointing to the Settings page; a clone whose identity was cleared cannot commit at all
(git's global identity is hidden). Scratch sessions need none.

### Push and pull requests

Both work two ways:

1. **By button** (session view, per repository): "Push" pushes the session branch (no force,
   set as upstream); "Create PR" creates a pull request with title, description, base branch
   and draft flag, pushing first when GitHub lacks the latest commit. The click is the user's
   approval. Repositories registered by clone URL push with the server's own credentials;
   local projects have no remote (put them on GitHub first).
2. **By Claude**: `git push` in a session clone gets its credentials from a credential helper
   (`apps/api/src/assets/git-credential-crm.cjs`, configured in every clone of a GitHub
   repository, with all other helpers reset). It asks `POST /api/git/credentials`,
   authenticated with a random token of the session's Claude Code process (in its environment,
   revoked when the process ends), for a token for exactly that repository of exactly that
   session. The token is read-only unless a `git push` command that the user approved in
   this session is running right now; then it may write, and it is revoked when Claude Code
   reports the command's result (at the latest after 15 minutes). Pull requests come from the
   tool `create_pull_request` (repository, title, body, base branch, draft), which never
   pushes and runs only for a call the user approved, once.

Approval: every tool use that needs approval goes through `canUseTool` and the user's answer
(see [Approval requests](#approval-requests)); "allow for this session" is never offered for
these two. Approvals are what unlock them, not Claude Code's own decision: `git push` has an `ask` permission rule in every session (it wins
over allow rules, e.g. from a repository's `.claude/settings.json`), the tool has the MCP
permission policy `always_ask`, and if anything still skipped `canUseTool` (a permission mode,
an allow rule) no grant is recorded, so the helper stays read-only and the tool refuses.

The approval request carries, for every `git push` in a Bash command, what it would update
(`gitPushes`: remote, destinations, force, deletes, all branches or tags, and whether it pushes
only the session branch, with warnings otherwise; `apps/api/src/app/agent/git-push-analysis.ts`),
so the approval dialog can warn: the approval lets the helper write to the whole repository,
including e.g. `git push origin HEAD:main`.

What this boundary cannot guarantee:

- An approved command does whatever it does. A push grant is recognized from the command
  text (`git … push`) and holds for the whole session (all its GitHub repositories, every
  process) while that command runs; a command like `git push && git credential fill` would
  show a write token to Claude. Commands that push in other ways (scripts, aliases) are not
  recognized and get a read-only token, which fails safely.
- Read-only tokens are available to every process of the session at any time (for
  `git fetch`), e.g. by running the helper or `git credential fill`, which itself is a Bash
  command that needs approval.
- Sessions are separated from the API (see [Users](#users-and-what-sessions-can-reach)), not
  from each other: all sessions share the session user, so a process of one session can read
  another session's clones and process environment (its session token). Claude Code asks
  before reading outside the session's directories, so only an approved tool use gets there.
- In development (`single-user`) none of this separation exists.

### Local projects on GitHub

"Put on GitHub" (`POST /api/repositories/:id/github`) creates a repository and pushes the
project's branches and tags there, or attaches an existing empty repository the app can
access. Organizations: `POST /orgs/{org}/repos` with an installation token (Administration
permission). Personal accounts: the app cannot create repositories there. GitHub's
documentation lists `POST /user/repos` for installation tokens, but for this app GitHub
answers `403` ("Rate Limit Exceeded", with
`x-accepted-github-permissions: administration=write; repository_creation=write`). The form
therefore offers creating only in organizations; for the personal account, create an empty
repository on GitHub and attach it.

## PR automation

Per open pull request of a session the session view (git panel) offers two switches, both
off by default, with the attempt count and limit, "Reset count", what started the last run,
and "Stop autofix" while a run goes on (`apps/api/src/app/pr-automation`).

- **Autofix**: a failed CI check of the pull request's current head commit, or new review
  feedback from someone with write access to the repository, continues the session with what
  failed or what the reviewers wrote. Claude fixes it, commits and pushes the session branch.
- **Autoclose**: when the pull request is merged or closed and the session has no open pull
  request left, the session ends, its dev servers stop (`DevServers.stopSession`, the hook for
  the dev-server step; nothing to stop yet) and its clones are removed, except clones with
  work that is not on GitHub.

### Where events come from

GitHub's state is the source of truth: webhook deliveries and polling only say _when_ to look.
A check (`PrAutomationService.check`) reads the pull request through the API with an
installation token for that repository (`metadata`, `checks`, `statuses`, `pull_requests`,
`actions`, `issues`: read), stores state and head commit, and acts. Checks of one pull request run one
at a time; one asked for meanwhile runs afterwards.

- **Webhook** `POST /api/github/webhook` (the GitHub App's webhook, events `pull_request`,
  `pull_request_review`, `pull_request_review_comment`, `issue_comment` (only comments on
  pull requests are followed), `check_run`, `check_suite`, `status`; `ping` is answered). It is the one route reachable without the Cloudflare Access
  login, exempt from the Access check and from the request guard, and authenticated only by
  its signature:
  - without a secret (`GITHUB_WEBHOOK_SECRET_FILE` or `CRM_SECRET_GITHUB_WEBHOOK_SECRET`,
    at least 16 characters; a configured but unusable secret stops the start) every delivery
    is refused (503);
  - the body is read raw, JSON only (415 otherwise), at most 1 MiB (413), and
    `X-Hub-Signature-256` (`sha256=` and 64 hex digits) is compared with the HMAC-SHA256 of
    exactly those bytes with `timingSafeEqual` before anything else is looked at (401 for a
    missing, malformed or wrong signature);
  - a delivery ID (`X-GitHub-Delivery`) seen before is not processed again (200), events the
    automation does not use are acknowledged and ignored (202);
  - what passed is only a signal: the repository ID and pull request numbers it names select
    pull requests the app knows (open, with automation, or any open one for
    `pull_request`), which are checked after 15 s (deliveries arriving together cause one
    check). Text in the payload is never used. Session processes are refused on this route
    like on the management API, and the secret never reaches them (`CRM_SECRET_` variables
    and the file are kept from child processes; the entrypoint checks the file's owner).
- **Polling**: every open pull request with autofix or autoclose is checked every
  `PR_POLL_INTERVAL_SECONDS` (default 120 s without webhook secret, 900 s as backstop with
  one; `0` turns polling off), one after another. A check costs about six requests
  (pull request, check runs, statuses, reviews, review comments, conversation comments) plus
  permission lookups
  (cached ten minutes) and logs of failed jobs; a rate limit pauses the automation until
  GitHub's reset time. Pull requests without automation are read when their session is
  opened, as before.

### Autofix

- **What counts**: failed check runs (`failure`, `timed_out`, `startup_failure`) and commit
  statuses (`failure`, `error`) of the head commit GitHub reports now; failures of older
  commits are stale and ignored, checks that are queued or running are not failures. Reviews,
  review comments and comments in the pull request's conversation created after autofix was
  turned on (or after the last run), by users
  whose permission on the repository is admin, maintain or write
  (`GET /repos/{owner}/{repo}/collaborators/{user}/permission`); bots (the app itself,
  Actions, other apps) and everybody else never start a run. Approvals and empty reviews ask
  for nothing and are skipped.
- **Coalescing**: one run handles everything that is current: all failed checks of the head
  commit (the run waits until the commit's other checks have finished, at most 30 minutes
  after the first failure) and all new reviews and comments, also when a review comes with
  ten comments or both arrive together. A head commit's failures start at most one run;
  feedback is new only once.
- **Busy sessions**: a run starts only while the session waits for a message (not while a
  turn runs, an approval, question or plan waits, the first message is held back, or the
  session is finished or failed). Events meanwhile are not queued: when the session waits for
  a message again, the pull request is checked again and one run covers what is still
  current then (stale CI results are dropped on the way). The owner's own messages are never
  held back by the automation.
- **The run**: a message composed by the app (`origin: 'app'`, shown in the history as "Sent
  by the app · PR automation"): fixed text with the attempt, the repository, the pull request
  number, the head commit and the session branch, nothing written by others. The failed
  checks (name, conclusion, output title and summary, and for GitHub Actions jobs an excerpt
  of the job's log: colour codes and timestamps removed, from before the first to after the
  last `##[error]` line, at most 150 lines / 12,000 characters, read from at most the last
  256 KiB of the log) and the review feedback (author, state, file and line with the end of
  the diff hunk, each at most 4,000 characters, the latest 50) go as untrusted context
  (`SessionsService.sendMessage` with `untrusted`, see [Untrusted content](#github-references-123)),
  at most 60,000 characters with a note on what was left out.
- **Attempts** are counted per pull request in the database (so they survive restarts) when a
  run starts; a run that could not start is not counted. Default limit 3, adjustable from 1 to
  20 per pull request. At the limit no run starts; the owner is notified once
  (`notifyAutofixGaveUp`) and the history says so. Only the owner resets the count ("Reset
  count") or raises the limit; turning autofix off and on does not reset it.
- **Stop autofix** stops the running turn and turns autofix off for that pull request; the
  attempt counts.
- **Several pull requests** (one per repository): switches, counts and runs are per pull
  request; a session runs one autofix run at a time, the others wait until it is idle again.

### git during autofix

While autofix is on for an open pull request, Claude may stage, commit and push its session
branch without approval: a Bash command that is nothing but `git add`, `git commit` and
`git push` joined with `&&` (optionally `cd <clone> &&` first or `git -C <clone>`), read
strictly (`apps/api/src/app/pr-automation/autofix-git.ts`). The app carries such a command
out itself instead of a shell, step by step, stopping at the first failure like `&&`:

- `git add` (`-A`, `-u`, paths inside the clone; no `-f`, `-p`, pathspec magic, `..` or
  absolute paths) and `git commit` (message with `-m`/`--message`, `-a`, `-q`, `-s`,
  `--amend` only of a commit no remote-tracking branch has, since amending a pushed commit
  would need a force push) run as the session user in that clone, on its session branch.
- `git push` must be last and, by the push analysis, push only the session branch (no force,
  no delete, no tags or `--all`/`--mirror`, remote `origin` or none). The app pushes the
  session branch like the Push button: the commits go into the mirror as a bundle and the API
  pushes `<commit>:refs/heads/<session branch>` without force, with a token that never
  reaches the session. A push alone without directory pushes every autofix clone with new
  commits; `add` and `commit` without `cd`/`-C` are accepted only in a session with a single
  clone (the shell's directory is unknown).
- Anything else in the command (other commands, pipes, `;`, redirections, subshells,
  command substitution or here-documents, unquoted globs, `git -c …`, other git commands or
  options) makes the whole command go to the owner as the permission mode says, as do
  other branches and repositories, force, tags and deletions. When new commits change
  `.github/workflows`, the commit is made but the push is not: Claude is told so, and a
  `git push` of its own then asks the owner (workflows can reach the repository's secrets).

**Hooks and configuration.** A commit would normally run the clone's hooks, and `git add` can
run clean filters, fsmonitor or signing programs named in git configuration. These are code
from the clone that Claude itself can write, so running them without approval would let any
command run unapproved. The app therefore runs these commands with hooks off
(`core.hooksPath=/dev/null`, as all its git commands), without global and system
configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; the session user's own
`~/.gitconfig` is Claude's to write), with fsmonitor and commit signing off, and only when the
clone's own configuration holds nothing but what git and the app write there (core basics,
`remote.origin`, `branch.*`, identity, the credential helper); otherwise it asks. Repository
hooks such as linters therefore do not run for autofix commits (`--no-verify` is accepted, as
it changes nothing); CI checks the result.

**What Claude and the owner see.** Claude Code runs only a command that prints the app's
report (`printf … | base64 -d`, failing with exit status 1 when a step failed), so Claude gets
the real output of every step and a failure never looks like success. The history shows the
tool call as "done by the app" or "failed" with what the app did ("Staged; Committed; pushed
… at …"), from a stored `tool.by_app` event that survives reloads and restarts. The
permission mode is never changed by the automation, and bypass modes stay unavailable.

### Merge and close

A merge or close (seen by a check, a webhook-triggered check, or the refresh when the session
is opened) is handled once per pull request: the owner is notified
(`notifyPullRequestClosed`, with what autoclose did), and with autoclose on and no open pull
request left in the session, autoclose ends the session, stops its dev servers and removes
each clone that has nothing that is not on GitHub: no uncommitted (modified, staged,
untracked and not ignored) files, no commits on local branches that no remote-tracking branch
has (the pull request's head on GitHub counts as pushed) and no stash entries. Clones with
such work are kept: the history and the notification say so, and the session view shows
"Autoclose kept the clone of …" with "Delete clone…", which opens a confirmation dialog
listing the files, commits and stash entries that would be lost (read when it opens,
`GET …/clone-loss`), and deletes only after confirmation
(`POST …/discard-clone` with `confirm: true`, finished sessions only). A session whose clones
were removed cannot be resumed.

### Setting it up at deployment

1. Choose a random secret (e.g. `openssl rand -hex 32`), store it as a file readable only by
   UID 1000 (`GITHUB_WEBHOOK_SECRET_FILE`, Compose secret `github-webhook-secret`).
2. In the GitHub App's settings: Webhook active, URL
   `https://<public host>/api/github/webhook`, content type `application/json`, the same
   secret, SSL verification on. Subscribe to the events Check run, Check suite, Issue
   comment, Pull request, Pull request review, Pull request review comment and Status.
3. In Cloudflare Access: a Bypass policy (or a separate application with a Bypass policy) for
   exactly the path `/api/github/webhook` of the public host, nothing else. Without it GitHub's
   deliveries end at the Access login; polling still works then, at its slower backstop
   interval.
4. Check the delivery log on GitHub ("Recent Deliveries"): `ping` should answer 200.

Without a webhook (no secret) everything works through polling every two minutes.

## Container

### Build and run

```sh
docker compose up -d --build           # builds the image and starts it on http://localhost:8080
curl http://localhost:8080/api/health
```

The compose file publishes the port on `127.0.0.1` only. The app has no login of its own (in
production it sits behind Cloudflare Access) and runs Claude with broad tool permissions, so do
not expose it on other interfaces without an authenticating proxy or tunnel in front of it.

Or without Compose:

```sh
docker build -t claude-remote-manager:local \
  --build-arg VERSION=0.0.0 --build-arg COMMIT="$(git rev-parse HEAD)" \
  --build-arg COMMIT_TIME="$(git log -1 --format=%cI)" .
```

The GitHub workflow `.github/workflows/docker.yml` runs lint, tests and builds, then publishes
the image to `ghcr.io/<owner>/claude-remote-manager` (tags: branch, PR, semver from `v*` tags,
commit SHA, `latest` on `main`). `VERSION`, `COMMIT` and `COMMIT_TIME` end up in `/api/health`.

The image (linux/amd64, Debian based) contains Node.js 24, git, openssh-client, curl, the
Claude Code CLI and Nix (single-user, flakes enabled). The `claude` command is the native
binary that ships with the Agent SDK, so the CLI and the sessions always use the same version.
It listens on port 8080.

### Users and what sessions can reach

The image runs with `PROCESS_ISOLATION=separate-users`:

| User     | UID (build arg)   | Runs                                                                     | Owns                                                        |
| -------- | ----------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `crm`    | 1000 (`API_UID`)  | the API                                                                  | `/data/db` (0700), `/data/git` (0700), mirrors, GitHub key  |
| `claude` | 1001 (`USER_UID`) | Claude Code, setup scripts, git in session clones, the credential helper | `/data/claude`, `/nix`, session clones, scratch directories |

The container starts as root only for the entrypoint (`docker/entrypoint.sh`): it gives the
volumes these owners (also volumes of older images), checks that the session user cannot read
the GitHub App key, and starts the API as `crm` with exactly the capabilities CHOWN,
DAC_OVERRIDE, KILL, SETGID and SETUID (ambient, through `capsh`; do not drop them from the
container). The API starts every session process through `setpriv` as `claude`, with all
capabilities dropped and `no_new_privs`, and with an environment built from an allowlist
(`SESSION_ENV_ALLOWLIST` in `apps/api/src/app/common/process-isolation.ts`); its own git
commands on the mirrors run without capabilities too. It refuses to start as root or without
the capabilities.

Session clones still hardlink the mirrors' objects: the API makes the clone (with
`fs.protected_hardlinks` only the owner may link the mirror's read-only object files) and
hands it to `claude`, except the hardlinked object files, which stay the mirror's (changing
their owner would change the mirror's files). The session owns all directories, so commits,
`git gc` and deletes work, but it cannot change or delete mirror content. Pushes by button run
in the mirror: the session user writes a bundle of the branch, the API fetches it and pushes,
so no token reaches a session process and git never runs as the API in the session's
repository.

What a session process can and cannot reach (checked in the container):

- cannot: read the GitHub App key, the database, `/data/git` (the API's SSH key and git
  configuration), the API's `/proc/<pid>/environ`; write or delete in the mirrors; call the
  management API (refused by peer user, see [Authentication](#authentication)); become
  another user (`setpriv`/`su` fail);
- can: its clones, `/data/claude` (login, transcripts, memory), `/nix`, the credential
  endpoint with its session token, and everything of other sessions (same user), including
  their dev servers on loopback; expose ports of its own user through `expose_port` (never the
  API's or root's, see [Previews](#previews-of-dev-servers)); not open preview hosts through
  the API's port.

Sessions have no ambient git credentials anymore: repositories registered by clone URL are
fetched and pushed (by button) by the API with `/data/git`; Claude's own `git push` works only
for GitHub repositories (credential helper).

### Volumes

All state lives in volumes under `/data`, plus the Nix store, which has to stay at `/nix`:

| Path              | Contents                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `/data/workspace` | `repos/` (mirrors), `sessions/<slug>/<owner>/<repo>` (session clones), `scratch/<slug>`         |
| `/data/claude`    | Claude Code configuration dir (`CLAUDE_CONFIG_DIR`): login, settings, transcripts               |
| `/data/git`       | the API's `ssh/` (linked as `~crm/.ssh`: key, `known_hosts`), `gitconfig` (`GIT_CONFIG_GLOBAL`) |
| `/data/db`        | SQLite database, `files/` (attached images, snapshots of shown files; API user only)            |
| `/nix`            | Nix store and Nix's user cache, so tools are downloaded only once                               |

The paths are also available to the app as `DATA_DIR`, `WORKSPACE_DIR`, `DB_DIR`,
`CLAUDE_CONFIG_DIR` and `GIT_CONFIG_GLOBAL`. The workspace must be one volume (one filesystem),
so that session clones can hardlink the mirrors' objects.

`docker-compose.yml` uses named volumes. Bind mounts work as well; the entrypoint creates
missing directories and gives them their owners (see the table above).

**Nix store volume.** A volume over `/nix` hides the Nix installation in the image. Docker fills
an empty _named_ volume with the image content on first use, so that case needs nothing else.
For everything else the image contains a compressed copy of its `/nix` in `/opt/nix-seed`, and
the entrypoint checks on each start whether the image's Nix profile exists in `/nix`:

- empty `/nix` (e.g. a new bind mount): the copy is unpacked;
- `/nix` from an older image (profile missing): the image's store paths are added and registered
  in the existing Nix database, everything already in the store is kept.

### GitHub App key in the container

Mount the private key as a file and point `GITHUB_APP_PRIVATE_KEY_FILE` to it, e.g. with a
Compose secret (see `docker-compose.yml`):

```yaml
services:
  claude-remote-manager:
    environment:
      GITHUB_APP_ID: '123456'
      GITHUB_APP_PRIVATE_KEY_FILE: /run/secrets/github-app-key
    secrets:
      - github-app-key
secrets:
  github-app-key:
    file: ./secrets/github-app.pem
```

Compose bind-mounts the file with its host owner and mode; it must be readable by the API user
(UID 1000) and not by the session user (UID 1001), e.g. owned by UID 1000 with mode `0400`
or `0600`. The entrypoint refuses to start otherwise. The same applies to the ntfy token
(`NTFY_TOKEN_FILE`) and an own VAPID private key (`VAPID_PRIVATE_KEY_FILE`); generated VAPID
keys live in `/data/db/vapid-keys.json` (owned by `crm`, mode `0600`). Or without Compose:
`docker run -v /path/github-app.pem:/run/secrets/github-app-key:ro -e GITHUB_APP_ID=…
-e GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-key …`. Never put the key into the image
or the compose file itself.

### Logging in to Claude

Claude Code uses the Claude account (subscription), not an API key. Log in once inside the
running container; the credentials are stored in `/data/claude/.credentials.json` and survive
restarts and re-creations of the container.

```sh
docker compose exec -u claude claude-remote-manager claude
```

Log in as the session user (`-u claude`): `docker compose exec` runs as root otherwise (the
entrypoint gives `/data/claude` back to `claude` on the next start). On first start Claude
Code asks you to log in (otherwise type `/login`). Choose the Claude account, open the shown
URL in your browser and paste the code back into the terminal. Check the result with
`docker compose exec -u claude claude-remote-manager claude auth status`.

Alternative for setups without an interactive terminal: run `claude setup-token` (anywhere, also
in the container) to create a long-lived OAuth token and pass it to the container as the
environment variable `CLAUDE_CODE_OAUTH_TOKEN`. The token is a secret; do not put it into the
image or the compose file in plain text.

### Global CLAUDE.md

`docker/CLAUDE.md` holds the rules for all sessions in the container (directory layout,
session clones, Nix, git). The image installs it as the managed policy file
`/etc/claude-code/CLAUDE.md`, which Claude Code loads in addition to the user's
`/data/claude/CLAUDE.md`. That way it is not hidden by the Claude volume and image updates take
effect immediately, while personal additions can still go into the volume.
