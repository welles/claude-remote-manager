# Claude Remote Manager

A self-hosted web frontend for managing Claude Code sessions on a home server: sessions that
work on several repositories at once, each in its own clone of the repository, with live chat, diffs and
cleanup. It is not a sandbox: on a NixOS machine (see
[Running as a NixOS service](#running-as-a-nixos-service)) it runs as the owner's user, and a
session can do everything Claude Code started by that user in a terminal can do, with the
user's own `~/.claude`, git and GitHub credentials and rights; the app adds session management,
per-session clones, PR automation, notifications, previews and the mobile UI on top. It also
runs in one Docker container. See [docs/specification.md](docs/specification.md) (German) for the
full specification.

Current state: repositories are chosen from GitHub through the app's GitHub App (or registered
by clone URL), local projects by name; sessions run through the Claude Agent SDK in their own
clones of one or more repositories (or in a scratch directory) and stream to the chat view,
where Claude's approval requests, questions and plans are answered; model and permission mode
are chosen per session and switchable while it runs; messages sent while Claude works are
queued; Claude's task list, the context window and the account's plan limits are shown; every
file change appears as a diff in the history and in approvals, new commits as a card on the
tool call that made them, and a changes page shows the whole session's diff and commits per
repository and file (each commit with its own diff), a files page its directories (changed files
marked); images can be attached to messages, files of the
session referenced with `@`, Claude Code's slash commands and skills completed after `/`,
Claude Code's suggested next message as placeholder of the input (Tab takes it, Send sends it),
GitHub issues and pull requests with `#` (Claude gets their
content as untrusted context), and Claude shows files to the user with `show_file`; session
branches are pushed and pull requests created by button, or by Claude (as the session's
permission mode allows, up to `bypassPermissions`); usage is recorded per request. Sessions notify the user over Web Push and ntfy
(approvals with Allow and Deny right in the notification), and the web app is an installable
PWA with an offline shell, badge, shortcuts and a share target. Per open pull request,
autofix continues the session when CI fails, reviewers with write access comment or the pull
request has merge conflicts (Claude rebases it onto the base branch and force-pushes with a lease),
automerge merges once CI is green, nobody requests changes and no review thread is open
(no approval needed; Claude can pause it for the owner's decision, or merge it itself with
`merge_pull_request`; Claude turns the switches on when asked, with `set_pr_automation`), and
autoclose ends the session and removes its clones when the pull request is merged or closed
(see [PR automation](#pr-automation)). Dev servers Claude starts become previews on host names
of their own, opened as links or embedded (see [Previews](#previews-of-dev-servers)).
Claude names each session with `set_session_title` once it knows what it is about and keeps
the title up to date, unless the user chose one. Sessions are renamed, archived, searched (titles, repositories, branches and the
conversation), cleaned up (push, merge into a local project, discard or keep their clones) and
deleted; leftover directories of the workspace are found and removed; usage and theoretical
API cost are charted per day, week and month (see [Managing sessions](#managing-sessions)).

## Workspace layout

Nx monorepo with npm:

| Path                 | Contents                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `apps/web`           | Angular app (standalone components, Angular Material, SCSS, Vitest)          |
| `apps/api`           | NestJS backend (Jest); serves the built web app and the API under `/api`     |
| `libs/shared-types`  | Types shared by both apps, imported as `@claude-remote-manager/shared-types` |
| `docker/`            | Files for the image: entrypoint, Nix config                                  |
| `claude-md/`         | The global `CLAUDE.md` for sessions: shared part, container and NixOS parts  |
| `Dockerfile`         | Multi-stage image build                                                      |
| `docker-compose.yml` | Local container setup with all volumes                                       |
| `flake.nix`, `nix/`  | Nix package, NixOS module, VM tests (see the NixOS section)                  |

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

Set the git author name and email first, `CRM_GIT_AUTHOR_NAME=… CRM_GIT_AUTHOR_EMAIL=… npm start`
(commits in session clones are made with them). Add a repository on the Repositories page (from GitHub if the GitHub App is
configured, see [GitHub](#github); or any clone URL git can use with the credentials of your
shell, or a local path), then start a session on it with a short prompt (choose Haiku to
keep it cheap), watch the answer stream in, send a follow-up, restart the API and send another
message: the session is resumed. Mirrors, session clones and scratch directories live in
`~/.local/share/claude-remote-manager/workspace` by default, outside this repository; the
database lives in `data/db` of this repository (gitignored).

For GitHub, start it with `GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_FILE=/path/to/key.pem`.

In development (`PROCESS_ISOLATION=single-user`) the API and the sessions run as you, with
your `~/.claude` and your global git configuration: credentials, and settings such as commit
signing, apply in session clones too, as on the NixOS service. `API_GIT_CONFIG_GLOBAL` gives
the API's own git commands on mirrors a configuration of their own; `GIT_CONFIG_GLOBAL` would
apply to the sessions as well. The tests never use your git configuration (each test runs git
with its own).

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
| `SESSION_IDLE_TIMEOUT_MINUTES`      | `60`                                                                                             | Close Claude Code processes idle this long (never while the session has previews); `0` keeps them        |
| `CLAUDE_CODE_EXECUTABLE`            | the binary bundled with the Agent SDK                                                            | Other Claude Code executable for the sessions                                                            |
| `CLAUDE_CONFIG_DIR`                 | `~/.claude` (image: `/data/claude`)                                                              | Read by Claude Code: login, settings, skills, plugins, MCP servers, transcripts                          |
| `MEMORY_DIR`                        | `$CLAUDE_CONFIG_DIR/repository-memory`, without it `~/.local/share/claude-remote-manager/memory` | Claude Code's auto-memory per repository (NixOS module: `<dataDir>/memory`)                              |
| `CRM_GIT_AUTHOR_NAME`               | none (sessions with repositories are refused)                                                    | Author name of the commits in session clones (with `CRM_GIT_AUTHOR_EMAIL`)                               |
| `CRM_GIT_AUTHOR_EMAIL`              | none                                                                                             | Author email of the commits in session clones                                                            |
| `GITHUB_APP_ID`                     | none (GitHub not configured)                                                                     | App ID of the GitHub App (plain configuration)                                                           |
| `GITHUB_APP_PRIVATE_KEY_FILE`       | none                                                                                             | File with the app's private key (PEM), e.g. a Docker secret                                              |
| `CRM_SECRET_GITHUB_APP_PRIVATE_KEY` | none                                                                                             | The private key itself, instead of the file                                                              |
| `AUTH_MODE`                         | none, required                                                                                   | `cloudflare-access` or `none`, see [Authentication](#authentication)                                     |
| `CF_ACCESS_TEAM_DOMAIN`             | none                                                                                             | Team domain (`<team>.cloudflareaccess.com`) for `cloudflare-access`                                      |
| `CF_ACCESS_AUD`                     | none                                                                                             | Application Audience (AUD) tag(s), comma-separated                                                       |
| `CF_ACCESS_ALLOWED_EMAILS`          | none (everyone Access lets in)                                                                   | Optional comma-separated email allowlist                                                                 |
| `PROCESS_ISOLATION`                 | none, required (image: `separate-users`, NixOS: `single-user`)                                   | `single-user` or `separate-users`, see [Users](#users-and-what-sessions-can-reach)                       |
| `SESSION_USER`                      | `claude`                                                                                         | OS user of session processes with `separate-users`                                                       |
| `SESSION_PATH`                      | the API's `PATH`                                                                                 | `PATH` of session processes (the user's profiles; may hold directories sessions can write)               |
| `LISTEN_ADDRESS`                    | all interfaces                                                                                   | Address the server listens on                                                                            |
| `INTERNAL_API_URL`                  | `http://127.0.0.1:$PORT`                                                                         | How processes on this machine reach the API; its port is never exposed as a preview                      |
| `SESSION_INSTRUCTIONS_FILE`         | none                                                                                             | Markdown appended to Claude Code's system prompt in every session (the NixOS module's instructions)      |
| `API_GIT_CONFIG_GLOBAL`             | none (the environment's `GIT_CONFIG_GLOBAL`)                                                     | `GIT_CONFIG_GLOBAL` of the API's own git commands on mirrors only                                        |
| `LEGACY_CLAUDE_CONFIG_DIR`          | none                                                                                             | Old configuration directory: its transcripts are copied to Claude Code's current one once, at startup    |
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
| `ENVIRONMENT_KEY_FILE`              | `$DB_DIR/environment.key` (created on first use)                                                 | Key (32 bytes, Base64 or hex) of the environments' secrets                                               |
| `CRM_SECRET_ENVIRONMENT_KEY`        | none                                                                                             | The key itself, instead of the file                                                                      |
| `ENVIRONMENT_FILES_DIR`             | `$TMPDIR/crm-environment-files`                                                                  | Files of environments per session process; emptied at startup                                            |
| `VAPID_PUBLIC_KEY`                  | derived from the private key                                                                     | Optional; checked against the private key                                                                |
| `VAPID_SUBJECT`                     | `PUBLIC_URL` if https, else a placeholder `mailto:`                                              | Contact for the push services (`mailto:` or `https:`)                                                    |
| `GITHUB_WEBHOOK_SECRET_FILE`        | none (webhook refuses everything)                                                                | File with the GitHub App's webhook secret (at least 16 characters), e.g. a Docker secret                 |
| `CRM_SECRET_GITHUB_WEBHOOK_SECRET`  | none                                                                                             | The webhook secret itself, instead of the file                                                           |
| `PR_TRUSTED_BOTS`                   | none                                                                                             | Bot logins (`name[bot]`, comma-separated) that count like write access (autofix)                         |
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
`apps/api/src/app/auth/authenticator.ts`): `GET /api/health` (no data),
`POST /api/github/webhook` (signature, see [PR automation](#pr-automation); session processes
are refused there too) and `POST /api/session-tokens/git|gh` (the session's process token; open
to session processes only, everyone else gets `403` `session_process_only`; see
[GitHub tokens in the container](#github-tokens-in-the-container)).
The notification routes (settings, devices, tests, the approval buttons) are not exempt.

**Session processes do not call the API.** Connections from a session process are refused
with `403` (`session_process_refused`) except on the health check and the token helper's
routes, in either auth mode, so a
session cannot, for example, answer its own approval requests. The client socket is looked up
in the kernel's socket table (`/proc/net/tcp*`, by ports and addresses: over loopback and to
the machine's or container's own addresses alike); connections from elsewhere (the tunnel on
another host, Docker's port publishing) have none there and are never refused.

- `separate-users` (the image): the client socket belongs to the session user.
- `single-user` (NixOS service, development): sessions run as the API's user, so the socket
  must also be held by a process the API started (`apps/api/src/app/auth/session-processes.ts`):
  one that descends from the API's process, or, when the API runs in a systemd service, one in
  the service's cgroup (that covers processes that detached with `setsid` or a double fork).
  The user's other programs on the machine (a browser, a terminal's `curl`, the Angular dev
  server's proxy in development) are not refused.

This is a guard against a session using the API by accident or on a whim, not a boundary: with
the user's rights a session can leave the cgroup (`systemd-run --user`), call the API as
another user (`sudo curl …`), or read the database
and the app's secrets. Still open with `AUTH_MODE=none`: every other process that can reach the
port.

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
- `Sec-Fetch-Site`: requests to the API (`/api`, any method) and WebSocket upgrades from a
  browser are accepted only as `same-origin` (the app, its service worker, its frames: the
  shown-file frame's request is made by the app's page) or `none` (a typed or bookmarked URL,
  e.g. a shown file opened in a new tab); `same-site` and `cross-site` are refused with 403,
  also for GETs without `Origin`. This matters for previews of dev servers: they are the same
  site as the app, so the browser attaches the app's cookies to their `<img>`, `<script>` and
  no-cors requests, which carry no `Origin`; the API does not have to rely on no GET route
  ever having an effect. Origins in `ALLOWED_ORIGINS` are other sites on purpose and exempt.
  Outside `/api` (the web app's pages, which Cloudflare Access redirects back to cross-site)
  only POSTs and other state-changing requests are refused this way. Non-browser clients such
  as curl or the container health check send no such header and work unchanged. One edge
  case: an API URL opened in a tab while the Access session had expired comes back from the
  Access login as a cross-site redirect and is refused; open it again from the app.
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
  repository's clone is the working directory (until Claude switches, see
  [Switching the working directory](#switching-the-working-directory)), the other clones are
  additional directories.
  The process stays alive
  for follow-up messages; several sessions run side by side. The process is an internal
  detail: it is closed after `SESSION_IDLE_TIMEOUT_MINUTES` without activity (not while the
  session has previews, see [Previews](#previews-of-dev-servers)) and when the server stops,
  and the next message starts it again with the SDK's resume option.
- SDK messages are mapped to session events (`libs/shared-types/src/lib/session-events.ts`):
  streamed text deltas, complete text blocks, tool calls and results, permission denials,
  notices, errors, turn results with usage, context usage and prompt suggestions. The server keeps an event log
  per session while it has a process or subscribers. A client that subscribes gets the whole
  log, or after a reconnect only the events after its last position (`logId` and `seq`), plus
  the text of blocks still streaming; then live events.
- History: conversation events come from Claude Code's transcript (`getSessionMessages`).
  Events the app produces itself (permission decisions, errors, notices, turn results,
  context usage, prompt suggestions) are stored in the `session_events` table and merged in at their place in
  the transcript. Status changes and text deltas are live-only. The Agent SDK returns
  transcript messages without timestamps, so rebuilt conversation events have `at: null`.
  An unused session's log is released and rebuilt this way when it is opened again.
- Status: `preparing` (clones and setup scripts; messages are refused until it is done),
  `running` (Claude works on a turn), `waiting` (waits for the user, whether or not a process
  is alive; `waitingFor` says for what: `message`, the next message; `permission`, an answer to
  an approval request, question or plan of the running turn; `setup`, a decision about the first
  message after a failed setup script, see below; `background`, nothing from the user: the
  turn is over, but background tasks Claude started (subagents, background commands, monitors,
  workflows; `background_tasks_changed` without ambient ones) still run, Claude Code continues
  on its own when they report back (shown as running, for at most 30 minutes after the turn,
  so a task that never ends such as a dev server does not hold it; the process is not closed for
  idleness; after the last one ended the session stays `background` for up to 30 seconds for
  the turn Claude Code starts with the report, which is `running`; "finished" is notified only
  after that; Claude can also say it itself with the tool `set_waiting_state`: `user` makes it
  `message` despite running tasks, `work` with a short reason (`waitingReason`, shown as the
  status) makes it `background` until the next turn, for at most 30 minutes after the turn;
  dropped after Stop, an error or a queued message; also `background` while the session waits
  for the CI of one of its open pull requests, ahead of Claude's `user`: the checks of the head
  commit run (at most 60 minutes after they were first read), for a minute after a push to its
  branch (noted right after Claude's `git push`, before GitHub reports the new head) or a new
  head commit until GitHub lists its checks (a repository without CI therefore shows it for a
  minute after each push), and with autofix (or during a turn or while Claude said `work`) after they settled
  until the PR automation looked at them (at most 2 minutes), so that its run, ready message
  or wake follows without `message` in between. CI that settled while Claude said `work`
  (or during the turn that ended with it), passed or not, wakes Claude with an app message
  naming each such pull request's head commit
  and how many checks passed, once no CI of the session runs any more and an app message may
  start a turn (no background task or review to report first), unless a run, ready message
  or merge started a turn, or the pull request is in a merge queue (its merge wakes Claude);
  `waitingReason` is then `CI of #12`, a message or an app
  message can still be sent, the process may still be closed for idleness, and such sessions
  are polled for the checks of those pull requests like viewed ones; "finished" is notified
  once per turn, not when such a wait began without a turn; also `background`, with
  `waitingReason` `Reviewing` unless Claude gave its own, while an independent review of the
  session runs); `limit`, the subscription's usage limit
  (5-hour or weekly window) ended the last turn (Claude Code's `rate_limit` error): the session
  continues by itself once the limit has reset, see [Usage limit](#usage-limit)), `finished`
  (ended with "End session", `POST /api/sessions/:id/end` or the `session.end` frame) and
  `failed` (a clone could not be created, or the process could not start or ended with an
  error during a turn). A message to a finished or failed session resumes it, unless its
  directories are gone (failed preparation, removed clones). A turn
  cut off by a server stop is recorded with a notice and the session waits again; on shutdown
  the server waits up to 5 seconds for the Claude Code processes to exit.
- Usage: every result message's tokens (input, output, cache write, cache read) and the SDK's
  theoretical cost in USD are stored per request and model in `usage_records`; the session
  shows the totals (see [Usage and cost](#usage-and-cost)). Context window usage is read from Claude Code (no API request) during a
  turn (at most every 5 s, live only) and after each turn (stored), so it survives reloads.
- Approvals: see [Approval requests](#approval-requests).
- Model and permission mode: chosen when the session is created and switchable at any time
  (`PATCH /api/sessions/:id` or the `session.update` frame): a running process switches right
  away (`setModel`, `setPermissionMode`), otherwise the next process starts with it. The models
  are the list Claude Code reports for the account (`GET /api/models`, read through a
  short-lived Claude Code process without prompt, cached for an hour; the aliases default,
  opus, sonnet and haiku if that fails). Modes offered: `default` (ask), `acceptEdits`, `auto`,
  `plan`, `dontAsk` and `bypassPermissions` ("Bypass (dangerous)": everything runs without
  asking, with all the rights of the user the sessions run as; marked in the attention colour in
  the mode control and the status strip). Every process is started with
  `allowDangerouslySkipPermissions` (`--allow-dangerously-skip-permissions`), which only makes
  the mode available, also for a switch while it runs; a user's or project's
  `disableBypassPermissionsMode` setting still applies (the session then runs in `default`,
  override reason `bypass_unavailable`). Mode changes Claude Code makes itself (entering plan
  mode, approving a plan) are taken over from its `status`/`init` messages. Changes are logged
  as `settings.changed` events. The new-session form preselects `auto` and always sends the
  chosen mode; a `POST /api/sessions` without `permissionMode` gets `default`.
- Auto mode (`auto`): Claude Code's classifier approves or blocks each tool use and asks the
  user through `canUseTool` only when it cannot decide; plan mode stays without it
  (`useAutoModeDuringPlan: false`). The app adds no limits of its own: `git push`,
  `create_pull_request`, `reply_to_review_thread` and `add_repository` are decided like any tool
  use, by the mode and the
  permission rules (the user's, the project's and those allowed for the session).
- Autofix runs (untrusted GitHub content as context) run in the session's chosen mode with its
  permission rules like any turn, `auto` and `bypassPermissions` included (the owner's
  decision: sessions work on trusted repositories). On top of the mode, the app's narrow
  `git add`/`commit`/`push` allowance (see [git during autofix](#git-during-autofix)) and
  replies with `reply_to_review_thread`, which only touch the session's own pull requests,
  run unasked during the run's turn when Claude Code asks (`canUseTool`). Resolving a thread
  with it (`resolve: true`) runs unasked there only when GitHub's own data shows a push in this
  run since the thread's last comment (never the clone's recorded push): the pull request's
  current head (read from GitHub) is the `after` of the branch's latest push or force push in
  the repository activity (`GET /repos/{owner}/{repo}/activity`, `contents: read`, GitHub's
  timestamp), and that push is later than the start of the run (when its message went to
  Claude Code) and than the thread's last comment not written by the app (GraphQL
  `viewerDidAuthor`; per comment the latest of `createdAt`, `publishedAt`, which for a review
  comment is when the review was submitted, and `lastEditedAt`). Missing or malformed data
  counts as not met. Right before resolving, the tool checks again (no newer comment, the
  same head); if that fails it only replies and says the thread stays open. This is a push
  since the comment in this run, not proof that the thread was fixed. Otherwise, and on any
  error, the user gets the approval dialog. In `dontAsk` Claude Code never calls
  `canUseTool`, so these allowances do not apply there.
  Where auto mode is not available (plan, model,
  settings), Claude Code starts in or falls back to `default` and reports it (`status`/`init`);
  the chosen mode stays, and the session's `permissionModeOverride` (`{ mode, reason }`, reason
  `auto_unavailable` or `bypass_unavailable`) says which mode is in effect while the
  process runs. The view shows it in the strip ("Ask (auto unavailable)") and under the mode
  control. Switching a running process to `auto` fails with Claude Code's reason when it cannot
  use it; after a model change the app asks for `auto` again (Claude Code does not return to it
  by itself).
- Queued messages: a message sent while a turn runs (also while it waits for an approval) is
  queued by the app (`message.queued`), not handed to Claude Code, and goes to Claude when the
  turn ends (all queued messages at once; Claude Code may take them as one turn). Until then it
  can be removed (`DELETE /api/sessions/:id/queued-messages/:messageId` or `message.unqueue`).
  "Send now" (`POST /api/sessions/:id/queued-messages[/:messageId]/send` or `queue.send`) stops
  the turn like Stop but keeps the queue: when the stopped turn ends, all queued messages (or
  the one chosen, which moves to the front; the others wait for the end of its turn) go to Claude.
  Stop, ending the session, a failed process or a server stop withdraw the queue
  (`message.dequeued` with `withdrawn`); the view offers the text again. Claude Code's own queue
  would take messages into the running turn earlier, but the SDK has no public way to remove
  one from it, so the app keeps the queue itself.
- Task list: Claude's task list is shown live from its `TaskCreate`/`TaskUpdate` (and, in
  other Claude Code versions, `TodoWrite`) tool calls, so it is rebuilt with the history. The
  bundled Claude Code offers these tools to SDK sessions only with
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, which every session process gets.
- Plan limits: the 5-hour, weekly and per-model weekly windows of each account (see
  [Accounts](#accounts)) come from `rate_limit_event` messages of the account's
  sessions and from Claude Code's plan usage request after turns; `GET /api/limits` (all
  accounts, in their order) reads them again through a short-lived process of the account when
  they are unknown or older than 5 minutes (the web app asks every 5 minutes), and a later
  answer drops windows it no longer lists. Changes go to all clients as `account.limits` (with
  the `accountId`). The session list's app bar shows the default account's 5-hour window as a
  meter (outlined in the error colour from 75 %, filled when
  exhausted; amber is kept for sessions that need the user); tapping it opens a dialog with
  every window of every account, per-model weekly ones included, with percent, reset time and
  when they were last updated. The session details show the list of the session's account.
- Integrations: each Claude Code process gets the tools `show_file` (always),
  `set_session_title` (unless the user chose the title, see
  [Managing sessions](#managing-sessions)), `add_repository` (always, see
  [Adding repositories to a running session](#adding-repositories-to-a-running-session)),
  `add_branch` (always, see
  [Several pull requests at once](#several-pull-requests-at-once)), `switch_directory` (always,
  see [Switching the working directory](#switching-the-working-directory)) and
  `create_pull_request`, `reply_to_review_thread`, `merge_pull_request`, `set_pr_automation`
  and `request_owner_decision` (when the
  session has a GitHub repository; all in the in-process MCP
  server `crm`), and the auto-memory directory of its main repository. No credentials: git uses
  the user's own (see [Push and pull requests](#push-and-pull-requests)).
- Session files are read by the API only through `apps/api/src/assets/session-files.cjs`, run
  as the session user: it opens the file, checks the real path of what it opened
  (`/proc/self/fd`) against the session's directories and refuses everything else (symlinks
  or `..` out, absolute paths elsewhere, directories, FIFOs, devices). Approval diffs, `@`
  listings of scratch directories and `show_file` use it; git in clones runs as the session
  user as well.
- Settings: sessions get Claude Code's own system prompt and the user, project and local
  settings of the user's configuration directory (`~/.claude`, or `CLAUDE_CONFIG_DIR` where set,
  as in the image), as in a terminal: login, `CLAUDE.md` files of the working directory and the
  user's, skills, plugins, hooks, memory; the managed policy `/etc/claude-code/CLAUDE.md` is
  always loaded. `SESSION_INSTRUCTIONS_FILE` (the NixOS module's description of the machine) is
  appended to the system prompt. On top, every process gets `useAutoModeDuringPlan: false` and
  `dialogExpiry: never` (approval requests wait for the user) as flag settings.
- MCP servers: as in a terminal (no `strictMcpConfig`): the user's MCP servers, a repository's
  `.mcp.json` as approved in the user's configuration, plugins and the Claude account's
  claude.ai connectors, plus the app's own tools (in-process server `crm`). The app's
  short-lived helper processes (model list, plan usage) start no MCP servers and fetch no
  connectors.

REST: `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`,
`PATCH /api/sessions/:id`, `POST /api/sessions/:id/messages`,
`DELETE /api/sessions/:id/queued-messages/:messageId`,
`POST /api/sessions/:id/queued-messages/send`,
`POST /api/sessions/:id/queued-messages/:messageId/send`,
`GET /api/sessions/:id/permission-requests`,
`POST /api/sessions/:id/permission-requests/:requestId`, `POST /api/sessions/:id/interrupt`,
`POST /api/sessions/:id/end`, `POST /api/sessions/:id/pending-message/send`,
`POST /api/sessions/:id/setup/rerun`, `POST /api/sessions/:id/repositories`,
`POST /api/sessions/:id/repositories/:repositoryId/addition/retry` (and `/accept`, `/remove`),
`POST /api/sessions/:id/repositories/:repositoryId/push`,
`POST /api/sessions/:id/repositories/:repositoryId/pull-requests`,
`POST /api/sessions/:id/pull-requests/refresh`, `GET /api/repositories`,
`GET /api/repositories/:id`, `POST /api/repositories`, `PATCH /api/repositories/:id`,
`POST /api/repositories/:id/fetch`, `POST /api/repositories/:id/github`,
`GET /api/repositories/:id/branches`, `GET /api/github/status`, `GET /api/github/repositories`,
`GET /api/settings`,
`GET /api/models`, `GET /api/limits`, `GET /api/health`, `GET /api/sessions/:id/diff`,
`GET /api/sessions/:id/diff/file`, `GET /api/sessions/:id/diff/commit`,
`GET /api/sessions/:id/diff/commit/file`, `GET /api/sessions/:id/files`, `POST /api/attachments`,
`GET /api/attachments/:id`, `GET /api/shown-files/:id`, `GET /api/shown-files/:id/content`,
`GET /api/shown-files/:id/live`, `GET /api/github/references`,
`GET /api/github/references/:owner/:repo/:number`,
`GET /api/sessions/:id/messages/:messageId/context`, `GET /api/notifications`, `PUT /api/notifications/preferences`,
`POST /api/notifications/push-subscriptions`, `POST /api/notifications/push-subscriptions/remove`,
`DELETE /api/notifications/push-subscriptions/:id`, `POST /api/notifications/test`,
`POST /api/notifications/approval-actions`,
`PATCH /api/sessions/:id/pull-requests/:pullRequestId/automation`,
`POST /api/sessions/:id/autofix/stop`, `GET /api/sessions/:id/repositories/:repositoryId/clone-loss`,
`POST /api/sessions/:id/repositories/:repositoryId/discard-clone`, `GET /api/sessions/:id/cleanup`,
`POST /api/sessions/:id/cleanup`, `POST /api/sessions/:id/archive`,
`POST /api/sessions/:id/unarchive`, `GET /api/sessions/:id/deletion`,
`POST /api/sessions/:id/delete`, `GET /api/search`, `GET /api/usage`,
`GET /api/workspace/orphans`, `POST /api/workspace/orphans/remove`,
`POST /api/workspace/missing/forget`, `POST /api/github/webhook` (GitHub only). WebSocket: `/api/ws` with the versioned protocol in
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
  Each repository also lists its commits since that comparison (newest 50, `commits`,
  `commitCount`).
- Commits: after every tool call that may move a branch (not reads, searches or file edits),
  after the app's own autofix commits and at the end of every turn, the app compares each
  clone's session branch with the commit it saw last (`session_directories.observed_head`;
  new clones start from their base commit, clones from before only note where they are) and
  stores what is new as a `commits.added` event on that tool call: the commits reachable from
  the branch but neither from that commit nor from `origin/<base branch>`, so a rebase shows
  the commits it rewrote (`rewritten`) and a merge of the base branch only its merge commit,
  newest first, at most 50 with up to 50 file stats each. One commit's diff against its first
  parent (a root commit: the empty tree) comes from
  `GET /api/sessions/:id/diff/commit?repositoryId=&branch=&sha=` (full commit IDs only, any
  commit the clone still has) with the same limits, a left-out file from `…/diff/commit/file`.
  The web app shows it on the session's changes page (`/sessions/:id/changes`), unified or
  side by side (kept per browser; unified by default on narrow screens); the cleanup dialog
  links to it ("Review the changes first").

### Images, `@` references, `/` commands, files and shown files

- Markdown: the input and the new-session form are a CodeMirror editor
  (`apps/web/src/app/markdown/`) that styles Markdown as it is typed while keeping the syntax
  (GitHub flavour); the text goes out exactly as written. Enter continues lists and quotes
  (an empty item ends them), Tab/Shift+Tab nest list items, GitHub's shortcuts format
  (Ctrl/⌘+B, I, E, K, Shift+X, Shift+8, Shift+7, Shift+.), and a toolbar shown with the
  text-format button (kept per browser) does the same. The editor offers the autocompletes a
  textarea-like interface (`TextField`) and works as a Material form field control. Sent
  messages render as Markdown in the history (raw HTML shown as typed, line breaks kept),
  their GitHub references as chips in place.
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
- File browser (`/sessions/:id/files`): `GET /api/sessions/:id/browse` lists each ready
  directory of the session with its files (the same listing as for `@`: in clones git's
  tracked and untracked, not ignored files; at most 20,000 per directory), shown as a tree per
  directory with a filter over all paths; files the session changed (from the session diff)
  are marked, folders with changes below them get a dot. A file opens in the file viewer:
  `GET .../browse/file?directory=&path=` says what it is (kind, media type, language, size,
  its `@` mention; from its first 8 KB), `GET .../browse/content?directory=&path=` serves it
  like a shown file's live content (read as the session user through the same helper, only
  inside that directory, also not through symlinks; relative paths without `..`; up to
  50 MB; never sniffed; HTML, SVG and text sandboxed by CSP, PDFs in the browser's viewer
  as for shown files). A directory that cannot be listed (gone) shows an error, the others
  stay; folders show 300 files until "more". "Reference in message" returns to the session
  with `?mention=@path`; the input takes one such reference (anything else in the parameter
  is dropped) after the text already typed, which the app keeps per session while it runs.
- `/` commands: a message starting with `/` offers Claude Code's slash commands and skills
  (`GET /api/sessions/:id/slash-commands`), names and aliases starting with what was typed
  first, then names containing it; choosing inserts `/name `. The list is what the session's
  Claude Code reported (`supportedCommands()` after its `init`, replaced by
  `commands_changed`; with the project's and plugins' commands, one row per name), kept in
  memory after the process ends; before the session's first process in the API's lifetime,
  the user's commands and Claude Code's own from a short-lived process without prompt
  (cached 10 min, 20 s timeout). Commands Claude Code marks as bound to a terminal
  (`terminal_slash_commands`) are left out. The message goes to Claude Code as typed, which
  runs the command; the transcript keeps it as tags, from which history rebuilt after a
  restart shows `/name args` again. The output of a command Claude Code runs itself (e.g.
  `/usage`) is shown live, but is not in the transcript and so missing after a reload.
- Prompt suggestions: sessions run with the SDK's `promptSuggestions`, so after a turn Claude
  Code may send its guess at the user's next message (`prompt_suggestion`, as the terminal
  shows it in its input; not after the first turn, after API errors, in plan mode, near the
  plan's limit, or when turned off with `promptSuggestionEnabled: false` in the user's settings
  or `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`, which wins over the setting). It is taken
  only when the turn ended without a stop and the session waits for the user: a suggestion
  arriving after the next message was sent is dropped. It becomes the stored event
  `prompt.suggestion` (history keeps only the newest); as in the terminal, the web app shows
  it as placeholder (in italics) of the empty input until a message is sent or queued, and
  not while a turn runs; the input grows to show it whole. Send (Ctrl+Enter) with the empty
  input sends it as it is, unless it is longer than the input's 8 lines; Tab or the
  edit button next to Send (touch screens) puts it into the input to change it. It comes from
  the conversation, which may contain untrusted content: once sent it is the user's message,
  with `@` expansion and slash commands.
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
  removal of files without a row at startup); deleting a session removes them (see
  [Managing sessions](#managing-sessions)).

### GitHub references (`#123`)

Typing `#` in the input (session view and new-session form) offers issues and pull requests
of the session's GitHub repositories (in the form: the GitHub repositories chosen there), by
number (prefix) or title words; nothing typed after `#` lists the most recently updated.
`owner/repo#…` searches that repository instead, if the GitHub App's installations can
access it. Sessions without a GitHub repository (scratch, local projects) offer nothing for a
bare `#`. Choosing inserts `#12` when the session has one GitHub repository, else
`owner/repo#12`. With several, a typed `#12` means the repository that has that number; when
several have it, the input lists them (title and state) instead of a chip, choosing one writes
`owner/repo#12`, and the message cannot be sent until that is settled (nor while the number is
still being looked up); a suggestion sent as offered goes without such a reference instead
(taken into the input, it asks as usual). Several clones of one repository count as one. When
none has it or GitHub cannot answer, it means the first. Chips
then show `repo#12`, in the input and the history. Every reference in the text becomes a chip above the input
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
  without a message the turn stops and Claude waits, with one Claude continues with it;
  `add_repository` requests carry `repositoryAddition`, see
  [Adding repositories](#adding-repositories-to-a-running-session)),
  `question` (Claude's `AskUserQuestion`: options, multi-select and own words; the answers go
  back as `answers` keyed by question text, multi-select labels joined with `, `), `plan`
  (`ExitPlanMode` in plan mode: the plan as Markdown; approve into `default` or `acceptEdits`,
  which is applied as a session `setMode` update, or keep planning with feedback).
- "Allow for this session" is offered only from Claude Code's own suggestions for the request,
  rewritten to the destination `session` (never to settings files): allow rules (not for all
  Bash commands at once) and directories, for pushes and the app's tools like for anything
  else. It never switches the permission mode (Claude Code's `setMode` suggestions, e.g.
  "accept edits" for a file change, are dropped): the mode changes only through the mode control
  and by approving a plan. It is never offered for questions and plans, or when Claude Code says
  not to (`suppressAlwaysAllowRule`). Rules and
  directories allowed for the session are given to every later Claude Code process of the
  session (`allowedTools`, additional directories), so they hold until the session ends.
- A request never stays pending without a process waiting for it: it is cancelled (resolved
  as `deny` with `cause`) when its abort signal fires or the user stops the turn
  (`interrupted`), the session is ended (`ended`), the process exits (`process_exit`), or the
  server stops (`restart`; after a crash the next start closes requests left open). Claude
  Code's own permission prompts have no deadline (`dialogExpiry: never` is set as well), so a
  request waits for the user as long as the process lives; the idle timeout does not apply
  while one is pending.

### Environments

An environment (page **Settings → Environments**, `/api/environments`) bundles what sessions need
for a kind of work and is chosen in the new-session form (one can be the default); it stays with the
session. It has:

- **Variables**: any `NAME=value`, set in the Claude Code process and in the setup scripts. Names
  the session or the app needs (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`, `GH_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_*`,
  `ANTHROPIC_*`, `CRM_*`, `GIT_CONFIG_*`) are refused.
- **Files** (e.g. a service account JSON, a kubeconfig): written for each process into a directory of
  its own below `ENVIRONMENT_FILES_DIR`, outside the clones, the path in a variable named per file;
  removed when the process ends. The directories stay the app's (`0711` with separate users, else
  `0700`) and only the files (`0600`) belong to the session user, so a session cannot plant
  symlinks where the app removes them; removal unlinks the known files, nothing recursive.
- **Secret switch** per variable and file: secrets are stored with AES-256-GCM (key from
  `ENVIRONMENT_KEY_FILE` / `CRM_SECRET_ENVIRONMENT_KEY`, else generated next to the database) and
  never returned by the API (only their length); the UI can replace or remove them. Secret values of
  at least 6 characters (for files the content, its JSON values, `KEY=value` and `key: value`
  values, and long lines without spaces) are replaced by `***` in the session's events
  before they are stored, sent or indexed (also `lastError`, titles set by Claude and streamed
  text and setup output, which are held back until they cannot be part of a secret), and when an older conversation is loaded from the
  transcript, with the current values. Claude itself knows the values; diffs, the file browser and
  shown files are not masked.
- **Instructions**, appended to the system prompt together with the names (not values) of the
  variables and files; a **setup script** that runs once after the repositories' scripts, in the
  working directory, with the same variables and files (retried with them); and **presets** for the
  form (repositories, model, permission mode).

Everything except the presets is read again at each process start, so a rotated key applies with
the next process. An environment cannot be deleted while any session uses it, archived ones included: their
transcripts hold the secrets, which are masked only while the environment exists.

## Managing sessions

All of it is in the session view (Rename in the app bar; Clean up…, Archive…, Unarchive,
Delete… in the session details), the
session list (search, the Archived filter) and the Workspace cleanup page (under Settings ›
Maintenance, also linked from Repositories). Every route is a management route: Access token required, refused to
session processes (see [Authentication](#authentication)).

- **Titles**: a new session is titled with the first line of its first message ("Image" or
  "Images" without text), or the title given in the form. Claude sets a short title of its own with the app's tool
  `set_session_title` (never asks, also not during an Autofix run) once it has read what the
  task refers to, and again when the topic changes substantially (the global `CLAUDE.md` of
  sessions says when); each change is a `settings.changed` line in the history, the tool call
  itself is not shown. `sessions.title_source` says where the title comes from (`prompt`,
  `user`, `claude`): a title the user gave or confirmed is never replaced. A process of such a
  session does not get the tool; one that has it when the user renames is told so by the
  tool. Sessions from before this have `prompt` (their origin is unknown) and get titles from
  Claude when they run again.
- **Rename** (`PATCH /api/sessions/:id` with `title`, 1-200 characters, or the
  `session.update` frame): only the title changes. The slug, the session branches
  `claude/<slug>` and the directory names keep their names (the form says so); search and
  statistics use the new title at once. From then on Claude no longer changes the title, also
  when the rename kept it as it was.
- **Clean up** (`GET`/`POST /api/sessions/:id/cleanup`): all directories of a session together,
  only when it has ended (finished or failed; not while a turn runs, waits for an approval or
  the session is being prepared). Per directory:
  - `push` (repositories with a remote): the session branch is pushed like the Push button
    (through the mirror, no force; nothing is pushed when the branch has no commits of its
    own), then the clone is removed;
  - `merge` (local projects): `GitService.fastForwardMirror` fast-forwards the base branch of
    the project's mirror to the session branch, then the clone is removed; when the base branch
    moved on, the clone is kept and the outcome says to merge it into the session branch
    first (in the session);
  - `discard`: the clone (or scratch directory) is removed;
  - `keep` (the default): nothing happens.

  What would be lost is read when the dialog opens (the PR automation's loss report:
  uncommitted, staged and untracked files, commits on local branches no remote-tracking
  branch has, stash entries; for a scratch directory all its files; and the size on disk), and
  for push and merge also what would still be lost afterwards. A choice that loses anything
  needs "I accept losing this" (`acceptLoss`); the API reads the loss again right before
  removing and keeps the directory if it is not empty and was not accepted. Failures (a push
  the remote refused) keep the directory and are reported; nothing else stops. The cleanup
  stops the session's previews and is recorded in the history. Afterwards the session reads
  as before but cannot be continued ("its directories were removed").

  **Remote branches** (`SessionRemoteBranches`): the preview also lists the session branches
  that are on the remotes of its repositories (`remoteBranches`), also of clones removed
  before (e.g. by autoclose after the pull request was merged). For each, the mirror is
  fetched and `GitService.commitsOnlyOn` counts the commits no other branch or tag of the
  remote has; for GitHub repositories the branch's pull requests are read too. A merged pull
  request whose head is the branch's commit (squash or rebase merges) counts as merged; an
  open one from the branch, or into it (`base`, e.g. of a session started on this branch),
  blocks deleting (deleting the branch would close it). A branch that loses nothing
  is offered checked, but only for GitHub repositories: elsewhere open pull (merge) requests
  are unknown (`pullRequestsChecked: false`), so it is offered unchecked with a note. If the
  remote or GitHub cannot be read, the branch shows the `error` and is not deleted (outcome
  `failed`). One with unmerged commits needs "I accept losing these commits"
  (`remoteBranches: [{ position, acceptLoss }]` in the cleanup and archive requests). The
  branches are deleted after the directories' choices, each checked again right before, with
  `git push --force-with-lease=<ref>:<checked commit> origin :<ref>` from the mirror (a branch
  that moved meanwhile stays). A branch cannot be pushed and deleted in the same cleanup.
  When unmerged commits were deleted, a kept clone forgets `origin/<branch>` and its pushed
  commit, so they count as lost again. The outcomes (`remoteBranches` in the result) go into
  the toast and the history.

- **Archive** (`POST /api/sessions/:id/archive` with the same choices,
  `POST /api/sessions/:id/unarchive`): ends the session (process and dev servers), cleans up
  as chosen (keep everything by default) and hides it from the list. Archived sessions take no
  messages, are listed under "Archived" (`GET /api/sessions?archived=only`; `include` lists
  all), are found by the search, and can be unarchived (and then continued if their
  directories are still there). The session list hears about archived and deleted sessions
  live (`session.updated`, `session.deleted`).
- **Delete** (`GET /api/sessions/:id/deletion`, `POST /api/sessions/:id/delete` with
  `confirm: true` and, if a directory holds work, `acceptLoss: true`): only for ended or
  archived sessions. The dialog lists what goes and what stays. Removed: its directories,
  Claude Code's files of the session in `CLAUDE_CONFIG_DIR` (the transcript
  `projects/*/<id>.jsonl` and its subagent directory, `file-history/<id>`, `session-env/<id>`,
  `tasks/<id>`; found by exact UUID with `find -P` and removed with
  `rm -rf --one-file-system`, as the session user), attached images, snapshots of shown files,
  stored events, pull request records, search entries. Kept: the usage records, attributed in
  `deleted_sessions` to the title and repositories the session had, and the pull requests on
  GitHub. Claude Code's prompt history (`history.jsonl`, typed in the CLI) is not touched;
  SDK sessions do not write to it.

### Removing directories safely

Every directory the app deletes (cleanup, delete, autoclose, rolling back a failed
preparation, leftovers) goes through `WorkspaceEntries`
(`apps/api/src/app/workspaces/workspace-entries.ts`):

1. **Text of the path** (`checkLexical`): absolute and normalized (no `..`, `.`, double or
   trailing slashes, no NUL), strictly inside `sessions/` or `scratch/` of the workspace, at the
   depth the kind needs (a clone is `sessions/<slug>/<owner>/<name>`, a scratch directory
   `scratch/<slug>`), and inside the session's own `<slug>`. A path from the database is
   never trusted beyond this: `../../etc`, the root itself, `sessions-evil/…`, another
   session's slug are refused before anything happens.
2. **The disk**: from the real path of the area's root down, every segment must be a real
   directory, not a symlink and not a file, so the path is its own real path.
3. **Other sessions**: a directory that is or contains a directory any other session uses is
   refused (a hostile row cannot make one session's removal reach another's clone; `app` and
   `app2` are told apart, not by prefix).
4. **Deleting without privileges**: `find -P <path> -xdev -mindepth 1 -delete` (no symlink is
   followed, no other filesystem entered) runs as the session user, who owns clones and scratch
   directories, then as the API's user without capabilities (the directories around clones
   and the object files hardlinked from mirrors are the API's), and `rmdir` removes the then
   empty directory. The API's own capabilities (`DAC_OVERRIDE` in the container) are never
   used for it, so even a symlink swapped in after the checks by a running session can only
   make it delete what the session user or the unprivileged API user could delete anyway, and
   `rmdir` of a symlink fails. Symlinks and hard links inside a clone are removed as links;
   their targets stay. In `single-user` development everything runs as the developer.
5. **What runs in it**: with `PROCESS_ISOLATION=separate-users`, a helper run as the session
   user (`stop-processes-in.cjs`) first stops that user's processes whose working directory
   lies in the directory (SIGTERM, SIGKILL after 5 s), except the API's direct children (the
   Claude Code processes, which the app ends or restarts itself). Dev servers, watchers and
   test runners Claude left running would otherwise write files again (such as
   `node_modules/.vite`) while the directory is deleted, and `rmdir` would fail. If it still
   fails, stopping and deleting are tried once more; then the removal reports
   `IncompleteRemovalError`. Its content is gone at least in part, so the clone counts as
   removed all the same (after its pull request, autoclose, session cleanup and deleting; the
   notice or the cleanup result names what was left), and the rest appears under
   [Leftovers](#leftovers). In `single-user` mode nothing is stopped.

Tested with hostile layouts (symlinked clone and parent directories, links to outside files,
database paths pointing elsewhere, a prefix-named sibling, a file where a directory belongs).

### Leftovers

`GET /api/workspace/orphans` lists directories under `sessions/` and `scratch/` that no session
claims (no session directory row that is ready or pending): clones (`sessions/<slug>/<o>/<n>`),
scratch directories, and other directories under `sessions/` without clones (empty ones left
behind). Symlinks there are never listed or followed. Each comes with what it holds, read as the
session user (size with `du`, files with `find -P`, and for clones the branch and the loss
report). `POST /api/workspace/orphans/remove` (`path`, `confirm`, `acceptLoss` when work would be
lost) removes only a path the list holds at that moment, with the rules above, and then its
empty parents. The list also shows directories sessions expect that are gone;
`POST /api/workspace/missing/forget` marks such a directory removed, so the session says it
cannot be continued. In the container (`separate-users`) these files belong to the session
user: inspection and removal run as that user through `setpriv`, as above.

### Search

`GET /api/search?q=` searches titles, repository names and branches (in the sessions' metadata)
and the conversation: the owner's messages and Claude's text answers (top-level, not those of
subagents), archived sessions included. Every word of the query must occur, as a substring and
in any case (Unicode lower case; `Größe` finds `größe`), within the same message. The query is
plain text: words become `LIKE` patterns with `%`, `_` and `\` escaped against the FTS5
trigram index, never FTS query syntax, so no input causes a syntax error (words of one or two
characters work too, without the index). At most 8 words, 200 characters; at most 50 sessions,
3 matches shown per session. Results show the session (title, repositories, archived) and
snippets with the words marked; a conversation match opens the session at that message
(`?at=<message ID>&q=`, scrolled into view and outlined; if the message is not found, the first
one containing the first word).

The conversation lives in Claude Code's transcripts and the app's stored events, and the history
is built from both, so the index follows the history:

- whenever a session's history is built (opening it, sending to it), its entries are replaced by
  what the history holds; if the transcript cannot be read, the entries stay as they were;
- while a session runs, each user message and each complete text block of Claude's is added as
  it arrives;
- at startup (2 s after), every session whose transcript changed or disappeared while the
  server was down is indexed again (the transcript's size and modification time, from the Agent
  SDK's `getSessionInfo`, are stored per session in `search_sessions`); a session whose
  transcript is gone keeps only what the app stored (its pending first message);
- deleting a session deletes its entries (cascade and triggers).

FTS5 with the trigram tokenizer is part of the SQLite that `better-sqlite3` builds (checked on
the host and in the image).

### Usage and cost

Every result message of Claude Code is recorded per model (input, output, cache write, cache
read tokens, and the SDK's cost estimate `costUSD`): `modelUsage` is cumulative per Claude Code
process, so the app stores the difference to the previous result (`UsageTracker`). That covers
the main loop, subagents and internal calls (a Sonnet session also shows a little Haiku usage).
Interrupted turns: the result of a stopped turn (`error_during_execution`) carries the usage of
the calls that completed, which is recorded; the request that was cut off is not in the SDK's
totals at all (checked with the bundled Claude Code: its `message_start` usage, input and cache
tokens without the final output count and without a cost, reaches the app only as part of the
streamed assistant message), so the app records nothing for it rather than an estimate.

`GET /api/usage?granularity=day|week|month&groupBy=session|repository|model&tz=&from=&to=`
sums the records per day, ISO week (Monday to Sunday) or calendar month and per group.
Day boundaries are those of the time zone the browser sends (`tz`, IANA name), UTC for none or
an unknown one; the page says which zone it uses. Default ranges: the last 30 days, 12 weeks or
12 months (at most 400 buckets). A session with several repositories counts once, under all of
them together (`acme/app + acme/lib`), so the groups add up to the total; scratch sessions are
"No repository". Deleted sessions keep their usage under their former title and repositories.

The Usage page (`/usage`, lazy-loaded) shows the totals (theoretical API cost, tokens,
requests), a stacked bar chart (plain SVG, no chart library; the six largest groups in fixed
colours, the rest as "Other", a legend, values of a bar on hover, focus or tap) and a table per
group with all four token counts and the cost. The cost is labelled theoretical everywhere:
what the requests would have cost at API prices, as the Agent SDK estimates it, not what the
subscription costs. The session view shows the session's totals the same way.

### Usage limit

When the subscription's usage limit (the 5-hour window or a weekly one) rejects a request,
Claude Code ends the turn with a synthetic assistant message whose `error` is `rate_limit`
("You've hit your 5-hour limit · resets 1:30am"); a `rate_limit_event` with `status: rejected`
names the window and its reset (`resetsAt`). The app then stops the session for the limit
instead of leaving it `Ready`: `sessions.limit_wait` (JSON: when, the window, when to continue,
whether that time is the known reset, whether the turn was an Autofix run) is set, the session
is `waiting` with `waitingFor: 'limit'` and `limitResumesAt`, a notice says so, and the turn's
notification (`turn_finished`) reads "Usage limit: …" with how long until it continues.

- **Another account first:** with several accounts (see [Accounts](#accounts)) the app
  switches the session to the next account in order after the exhausted one that is logged in
  and whose limits are not known to be exhausted, and continues at once with the new account
  ("the session continues with another account"; no usage-limit notification, a notice names
  both accounts). When every account is exhausted it switches to the one whose limits reset
  first (if that is not its own) and waits for that reset. An account found exhausted when the
  app reads its limits before continuing makes it wait for that one in turn; each limit that ends
  a turn moves on to the next account. The wait remembers its account (`accountId`) and the
  account whose limit stopped the session (`limitedAccountId`). The switch stores the new account on the
  session (also for one that followed the default account), so that it does not go back to the
  exhausted one; each account is tried at most once until a turn gets through, the user waits,
  continues or changes the account, or the session ends. An account the user chose during the
  turn stands, and one switched to is tried even when its limits cannot be read.
- **When it continues:** at the reset plus a minute. It reads the plan usage first (the probe
  process, as for the limits display): a window of the session still at 100 % (5-hour, weekly,
  or the one that was rejected) means waiting for its new reset; otherwise it continues. A
  reset that is not known (no `rate_limit_event`) is looked at after 5 minutes, after a
  continuation that hit the limit again, or when the limits cannot be read, after 30 minutes.
  Long waits are split into timers of at most an hour; the wait is stored, so it survives a
  restart (looked at 10 seconds after the start).
- **How it continues:** the messages the user sent meanwhile were queued (as during a turn:
  "sent when the usage limit resets", removable, "send now" sends them right away and ends the
  wait); they go to Claude then, in the running process or a new one that starts with the first
  of them. Without them the app tells Claude that the limit stopped its last turn and has reset,
  to continue where it left off and to check background tasks of that turn first (they may have
  ended with it). An Autofix run continues as one (it shows as going on again, and Stop Autofix works) if autofix is still on for its pull request
  and it is open, else as an ordinary turn; with held
  messages it is not continued as such: the user's messages go instead.
- **The user decides otherwise:** the session view shows a banner with "Continue now"
  (`limit.resume` frame, `POST /api/sessions/:id/limit-wait/resume`) and "Don't continue"
  (`limit.cancel`, `DELETE /api/sessions/:id/limit-wait`: the session waits for the next
  message, held messages are withdrawn). Ending or archiving the session ends the wait too; a
  turn that gets through meanwhile (one Claude Code starts by itself) ends it as well; one that
  fails otherwise or is stopped leaves the wait and its held messages. Claude Code's `rate_limit`
  errors of subagents (also background ones) do not count; a repository added during the turn
  the limit ended restarts the process once it is free, and Claude is told about it with the
  next message.
- **Meanwhile:** the PR automation starts no run (`acceptsAppMessage` is false); held messages
  live in memory and are withdrawn when the server stops.

### Accounts

Sessions can work with several subscription accounts (no API keys; Claude for now, ChatGPT
accounts follow with Codex as an equal engine). Settings → Accounts
lists them with their login (email, plan, organization from `claude auth status`),
their limits and the actions: add (name, then the login), log in again, log out, rename, make
default, move up/down (the order), remove (not the main account).

- **Directories:** the main account is Claude Code's main directory (`~/.claude`, or
  `CLAUDE_CONFIG_DIR`). Every further account has `<main>/crm-accounts/<id>` with its own login
  (`.credentials.json`) and state file (`.claude.json`: account, onboarding, per-project trust);
  everything else is a relative symlink into the main directory, created (and completed with
  entries added later) before every process of the account: transcripts (`projects/`),
  `settings.json`, `CLAUDE.md`, skills, plugins, agents, commands, memory and Claude Code's
  per-session state. The shared directories (and an empty `settings.json`) are created in the
  main directory first, so that Claude Code of another account never makes its own. The user's
  MCP servers are managed in the main account: `mcpServers` of the main state file replaces the
  account's when they differ, unless Claude Code holds the account's lock
  (`.claude.json.lock`; the next start copies them). The helper `assets/claude-account-dir.cjs`
  does all of this, and removes a directory, as the session user (through the launcher, like the
  file helper), so the API never writes into directories the sessions control with its own
  privileges; it refuses a `crm-accounts` or account directory that is a symlink and never writes
  through a symlinked state file (the main directory and the shared ones may be symlinks, e.g.
  skills from a dotfiles repository). Calls for the same account run one after the other.
- **Processes:** a session's Claude Code, its reviewer, and the probes (models, slash commands,
  plan usage) of an account run with `CLAUDE_CONFIG_DIR` set to the account's directory; only
  the main account gets `CLAUDE_CODE_OAUTH_TOKEN` (it would log every account in as the main
  one). Usage records keep the account (`usage_records.account_id`). The model list and the
  slash commands before a session's first process come from the default account.
- **Login in the UI:** `POST /api/accounts` (name) creates the account and starts
  `claude auth login --claudeai` as the session user with the account's directory; without a
  terminal it prints the login URL and reads the code from stdin. The UI shows "Open login
  page" and a field for the code (`POST /api/accounts/:id/login/code`), then the result; the
  login state is read again with `claude auth status` when it ends, at every start of the API,
  every 15 minutes and when the accounts are listed and the last read is older than 5 minutes
  (a login from a terminal, an expired one). `POST /api/accounts/:id/login` starts a new login (an expired one), `DELETE` cancels it
  (after 15 minutes it ends by itself), `POST /api/accounts/:id/logout` runs `claude auth logout`.
  Changes go to all clients as `accounts.changed` (all accounts, with their limits and logins).
- **Sessions:** `CreateSessionRequest.accountId` chooses the account; without it the default
  account, or, while its 5-hour or weekly window is exhausted, the first logged-in one in order
  whose limits are not (the default when all are). `sessions.account_id` keeps it (`null` for
  older sessions: the default account). The session's settings switch it (`accountId` in
  `PATCH /api/sessions/:id` or `session.update`): stored at once, effective when the process
  is free (as after `switch_directory`), the conversation resumes from the shared transcript.
  A switch while the session waits for the old account's limit makes the app look at the new
  account's limits at once and continue if it has room. Removing an account
  (`DELETE /api/accounts/:id`: logout, then its directory) moves its sessions to the default
  account; it is refused (409) while a Claude Code process of a session (also one starting), a
  reviewer or a probe uses it, and from its start no process starts with it any more (sessions
  take the default account). The directory goes first: if that fails, the account stays.
  Limits are not read for logged-out accounts.

### Engines

The session core is engine-neutral: it starts processes through an `AgentRunner` of the session's
engine (`sessions.engine`, `claude-code` for every session so far; `GET /api/engines` lists the
engines with their provider of accounts and capabilities) and only knows the app's own model in
`apps/api/src/app/agent/agent-events.ts`:

- **Events** (`AgentEvent`): the process started (its conversation ID, mode, commands that need a
  terminal), commands changed, background tasks, activity of the main agent, a mode change by the
  agent, a limit window reported during a turn, a limit that ended the turn, a suggestion for the
  next message, conversation output (session events with the transcript entry they follow,
  images, whether the context grew) and the turn's result (cumulative usage per model).
- **Approvals**: the engine asks an `AgentApprover` (`AgentApprovalCall` → `AgentApprovalResult`,
  with `AgentPermissionUpdate`s for "allow for this session" and an approved plan's mode).
- **Data**: limit windows and plan usage, context usage, models, commands and stored history in
  engine-neutral types.

Claude Code is the first adapter (`claude-events.ts`, `sdk-agent-runner.ts`, `sdk-event-mapper.ts`,
`transcript-reader.ts`): it translates the Agent SDK's messages, `canUseTool`, usage answers and
transcripts into this model; only these files use the SDK. Accounts belong to a provider; a
session uses accounts of its engine's provider (its own default account per provider, the
automatic switch only among them). The tests drive the session core through the same adapter
(the fake runner translates the SDK-shaped messages tests push). Still Claude Code only until the next engine
  arrives (and then per engine): the model list, the slash commands before a process, the plan
  usage probe and the independent review. A message an adapter cannot translate is logged and
  skipped; the events of one engine message are handled as a whole.

## Previews of dev servers

Claude starts a dev server in its session (in the background, in the session's directory) and
makes it reachable for the user with the tool `expose_port` (port, name). The user opens the
running app in the browser, with hot reload, as if it ran locally: every preview gets a host
name of its own, so absolute asset paths and hot-reload WebSockets work unchanged.

- **Addresses**: `<session slug>-<port>.<preview domain>`, from `PREVIEW_URL` (e.g.
  `https://preview.example.com` gives `https://2026-11-20-k3x9q2-5173.preview.example.com`;
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
- **Session view**: running previews in the session details (and a chip in the status strip) with state (running; not reachable, with
  the reason, e.g. "Nothing listens on port 5173"; stopped, checked every 3 s from the
  kernel's socket table), a link (new tab, no opener, no referrer), Embed and Stop; the
  history shows the same card where Claude exposed the port, and notes stopped previews
  (`preview.exposed`, `preview.stopped`, stored).
- **Stop** ends the forwarding (also open WebSockets); the dev server keeps running, Claude
  can expose it again. `POST /api/sessions/:id/previews/:previewId/stop`.
- **No idle shutdown while previews run**: dev servers Claude starts as background tasks of
  its Bash tool end with the Claude Code process (checked: after the idle timeout closed the
  process, such a server was gone, while one started with `nohup … &` survived). So a
  session with at least one active preview is never closed for idleness; when its last
  preview stops, the idle clock starts from then. The session view says so above the
  previews. A server restart still ends the processes (and their background dev servers);
  the previews then show "not reachable" until Claude starts the server again.
- **Session end** (End session, autoclose through `DevServers.stopSession`, cleanup, archiving
  and deleting)
  stops all its previews and, with `PROCESS_ISOLATION=separate-users`, the processes that
  listen on their ports: a helper run as the session user (`stop-listeners.cjs`) finds them
  by the listening socket's inode in its own processes' `/proc/<pid>/fd` and sends SIGTERM,
  SIGKILL after 5 s. Only listeners of the session user can be found and signalled. Which
  session started a process cannot be told (all sessions share the user `claude`), so this is
  the process behind the exposed port, whoever started it. In `single-user` mode (the NixOS
  service, development) the API stops only processes it started itself (descendants, or
  processes in its service's cgroup, see [Authentication](#authentication)) that hold a
  listening socket of the port; other programs of the user listening there are left alone.
  Dev servers Claude
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
  process listens (one user for all sessions); in `single-user` mode any service of the
  user's on loopback could be exposed (never the API's port).
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
  (`<img>`, `<script>`, no-cors `fetch`) carry `Sec-Fetch-Site: same-site` and are refused
  as well (checked in the browser: an `<img>` and a no-cors fetch of `/api/sessions` from a
  preview page were refused with 403).
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

| Event                         | When                                                                                                       | Withdrawn when                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Claude needs you              | an approval request, a question or a plan to review                                                        | it is answered or cancelled, anywhere    |
| Turn finished                 | a turn ended and Claude waits for the next message (not after Stop or a denial)                            | the next turn starts or the session ends |
| Session hangs                 | a running turn without any event for `SESSION_STALL_MINUTES` (once per stall)                              | activity resumes or the turn ends        |
| Session failed                | the session failed, or a setup script failed and the first message is held back                            | the session continues                    |
| Automerge needs you           | Claude asked for the owner's decision, GitHub refused the merge, or threads stay open that no run works on | –                                        |
| Removed from merge queue      | a merge queue removed a pull request without merging it, and no autofix run works on it                    | –                                        |
| Pull request merged or closed | a pull request of the session was merged or closed (reported by the PR automation)                         | –                                        |

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
`notifyAutomerge(sessionId, pullRequest, kind, detail)` (`held` with Claude's question,
`failed` with GitHub's reason, `waiting` for threads nobody works on) and
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
- **App shortcuts**: "New session" (`/new`, the cursor goes into the form; the older
  `/?new=1` is forwarded there) and "Waiting sessions" (`/?waiting=1`): the list filtered to
  the sessions that need the user ("Needs you", the same sessions the badge counts).
- **Share target**: links, text and images shared to the installed app become a new session's
  prompt and images: the service worker takes the operating system's form post
  (`POST /share-target`, multipart) itself, keeps it in the Cache API (dropped after a day if
  unused) and opens `/new?share=<id>`; the new-session form is filled in and the images are
  uploaded like attached ones (`POST /api/attachments`). The API never sees the form post,
  so its request guard stays JSON-only.
- **Layout**: on phones a bottom bar with Sessions (with the number of sessions that need
  the user), Repos, Usage and Settings on the top-level pages; detail pages (a session, its
  changes, a new session and Settings' Workspace cleanup) get the whole height
  and a back arrow in their app bar. From 840 px the destinations are a rail on the left. The
  start page lists the sessions grouped into Needs you, Running and Recent with search and
  filters; each row says what the session needs ("Approve command", "Approve repository",
  "2 questions", "Plan
  ready", from `SessionDto.pendingRequests`: kind and count only). "New session" (a floating
  button on phones) opens `/new`. The shell has no Material modules, so the start bundle
  stays small; pages load lazily.
- **Session view**: the app bar (title, repositories and branch, Rename, Changes), a sticky
  status strip (what the session needs, context, pull request, tasks, previews, model and
  permissions), the conversation (tool calls as compact rows with paths relative to the
  session's directories; the preparation as one row) and a dock at the bottom: the pending
  approval, question or plan with its buttons always in view (long content scrolls inside
  the card), queued messages collapsed to a count, and a one-row composer. Everything else
  (status, context, tasks, repositories, push and pull requests with their CI checks and
  automation,
  previews, model and permissions, usage, plan limits, end, clean up, archive, delete) is in
  the session details: full screen on phones, a drawer on desktops, a permanent column from
  1360 px. From 1100 px the session list stays on the left of an open session.
- **Look**: one Angular Material M3 theme (`apps/web/src/styles/`): graphite neutrals, one
  cool accent, amber only for "needs you", small radii, compact type and monospace for paths,
  branches and commands; light and dark follow the system. Components use the
  `--mat-sys-*` and `--app-*` tokens only; icons are inline SVG (`app/ui/icon.ts`), dates are
  English with the day before the month and a 24-hour clock, in the browser's time zone
  (`app/ui/dates.ts`), and shared pieces (status badge, banner, dialog, side panel, page app
  bar) are in `app/ui/`.
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
branch first if it moved on); the cleanup offers that as "merge". Pushes from session
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
- `sessions`: title, model, permission mode, status, the `slug`, the `pending_message` (the
  first message while it has not been sent to Claude), `archived_at` (archived sessions).
- `deleted_sessions`: per deleted session its title and repositories as they were, so its
  usage stays attributable; `usage_records` (tokens and cost per request and model) have no
  foreign key and keep the deleted session's ID.
- `search_documents` with the FTS5 table `search_index` (trigram tokenizer, external content,
  kept in sync by triggers) and `search_sessions` (what each session's entries were built
  from), see [Search](#search).
- `session_directories`: the session's directories in order; position 0 is the working
  directory, the others are additional directories. `kind` is `clone` (with `repository_id`,
  `branch`, `base_branch`, `base_commit` — the commit the branch started at, the fallback
  comparison point of the session diff — and `setup_status`), `scratch`, or `directory` (sessions from before session
  clones). `state` is `pending`, `ready`, `failed` or `removed`. This table is the only source
  of a session's directories (the former `sessions.cwd` was migrated into it). Repositories
  added while the session ran have `added_at`, `added_by`, `addition_state` (`preparing`,
  `failed`, `held`, `ready`; only `ready` ones are given to Claude), `addition_error` and
  `announce` (Claude still has to be told about it).
  `pushed_commit`/`pushed_at`: what was last pushed of the session branch (by button, or seen
  after an approved push by Claude).
- `pull_requests`: per session clone (session and repository) the pull requests created by
  button or by Claude: number, URL, title, state (`open`, `closed`, `merged`), draft, head and
  base branch, creator (`user`/`claude`), opened/closed/merged times and when the state was
  last read from GitHub (open ones at most once a minute when the session is opened), the
  head commit, and the PR automation per pull request: `autofix`, `autoclose`, the head commit whose failed checks were handled, the
  time after which reviews are new, the last run and what triggered it, whether a run is
  going on, when the merge or close was handled; for automerge: `automerge`, the hold
  (`automerge_held_at`, `automerge_hold_reason`: Claude's question), the head commit GitHub
  refused to merge and why, what a ready head commit waits for
  (`automerge_waiting`), and the head commit the owner was told about stuck threads for;
  for merge queues: the head commit the app or Claude added (`merge_queued_sha`, when, place,
  GitHub's entry state, the merge group's commit) and a removal waiting to be handled (head
  commit and GitHub's reason);
  `checks`: the CI checks of the head commit as last read, for the view (JSON).
- `sessions.autoclosed_at`: when autoclose ended the session; clones still `ready`
  afterwards were kept because they hold work that is not on GitHub.
- `webhook_deliveries`: IDs of processed webhook deliveries (a week), so redeliveries do
  nothing.
- `app_settings`: settings edited in the UI (key, JSON value): under `notifications` which
  events go to which channel. Rows `gitAuthorName`/`gitAuthorEmail` of earlier versions are
  unused (the commit identity comes from the environment).
- `message_contexts`: per user message with GitHub references or untrusted context: the
  references as resolved, the context text Claude got, the transcript UUID of the context
  message and the origin (`user`, or `app` for messages the app composed).
- `push_subscriptions`: the devices that receive Web Push (endpoint, keys, readable label,
  last success or error); removed when the push service reports them gone.

### How a session gets its directories

1. `POST /api/sessions` with `repositories: [{ repositoryId, baseBranch? }, …]` (the first is
   the main repository), `newProject: { name }` (creates the local project and makes it the
   main repository), or `scratch: true`. The request is validated and a slug is chosen:
   the date (in the time zone `TZ` names, else UTC) plus 6 random characters (`crypto.randomInt`), e.g. `2026-11-20-k3x9q2`,
   unique among sessions and directories. Nothing of the title or prompt goes into it, so the
   branch pushed to the remote and the directory names reveal nothing of the task.
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

### Adding repositories to a running session

A session can get a further repository while it runs, so that Claude continues in the same
conversation with both (e.g. a change to an app that also needs one in the machine's NixOS
configuration). Two ways in:

- **By the user**: "Add repository" in the session details (Repositories and pull requests),
  with the choices of the new-session form: a registered repository or local project, one from
  GitHub through the GitHub App, one by clone URL, a new local project (the last three are
  registered first, through the same routes and validation as in the form), and the base
  branch. `POST /api/sessions/:id/repositories` with `{ repositoryId, baseBranch? }`.
- **By Claude**: the tool `add_repository` (`repository` as `owner/name`, or `url`; optional
  `base_branch`; `reason`). It asks like any tool, as the session's permission mode and rules
  say (it runs without asking in `bypassPermissions`, for example). Before anything is asked,
  the call is checked as the form would check it
  (`apps/api/src/app/workspaces/repository-additions.ts`): a registered repository or local
  project by name, a repository of the GitHub App's installations by name, or a clone URL
  under the form's rules; local paths and `file://` are refused (Claude names no paths on the
  machine), as are repositories the session has already ("already part of this session: its
  clone is …"); refusals go back to Claude without asking. The approval shows the repository,
  where it comes from (GitHub App, clone URL, local project; whether it is registered yet), the
  base branch (or the default branch) and Claude's reason as plain text (untrusted, never
  rendered). It reads "Approve repository" in the session list and status strip, and the
  notification's Allow and Deny work as for a command. An approved call runs with exactly what
  the approval showed (kept by tool use ID, used once); a call that was not asked is checked
  the same way when the tool runs. Unregistered repositories are registered only then.

What happens then is the same for both: the repository gets its own clone
`sessions/<slug>/<owner>/<name>` from its mirror on the session branch `claude/<slug>`
(clone, ownership and setup script exactly as at session start, also with
`PROCESS_ISOLATION=separate-users`), shown in the history as one "Add repository" row with
its fetch, clone and setup steps (`prepare.progress` with step `add`, and an `addition` ID on
all its events). One repository is added at a time per session; cleanup, archive and delete
wait for it, and ending the session stops its setup script. Afterwards it is a directory like
the others: push and pull requests, the session diff, `@` and `#`, PR automation, cleanup,
archive, delete, search and statistics (a session's usage counts under all its repositories,
now including the added one).

**How Claude gets it, without a restart.** Claude Code takes its directories at process start,
but the bundled Claude Code (2.1.322, Agent SDK 0.3.322) also takes further ones while it
runs: the app sends the flag settings again (`Query.applyFlagSettings`) with
`permissions.additionalDirectories` listing the added clones (plus the launch settings'
`permissions`, which that call replaces). Checked with the bundled Claude Code against a local
fake Messages API: a `Read` of a file in the added directory, which asked before, ran without
asking afterwards, both between turns and when applied from inside an in-process tool call in
the middle of a turn, and Claude Code's next request carried a system reminder "Environment
update – Additional working directories added: <path>". (An allow result with
`updatedPermissions: addDirectories` behaves the same but exists only in an approval; the
`register_repo_root` control request accepts only subdirectories of existing directories.)
So:

- added while no turn runs: the process gets the directory at once; Claude is told the
  clone's path, branch and base branch with the next message, as a note of the app sent before
  it (`client_composed`, `shouldQuery: false`, `isSynthetic`, like untrusted context; not shown
  as a message of the user);
- added while a turn runs: the same, at once; Claude Code mentions the new directory with its
  next request in that turn, the app's note comes with the next message;
- added by Claude's tool: the tool waits until the clone and the setup script are done and
  tells Claude in its result where the clone is (path, branch, base branch and commit), or
  that it is not available and why. The turn goes on, so the history reads as one piece of
  work;
- no process: the next one starts with the directory and the note.

If a Claude Code (e.g. one set with `CLAUDE_CODE_EXECUTABLE`) cannot add directories, the app
restarts the process with resume instead: at once when no turn runs, after the turn when one
runs. For Claude's own call the tool result says so ("end your turn now"), and after the turn
the app continues the session with a fixed message of its own (`origin: 'app'`) saying that
the repository is now available at its path; queued messages follow as usual.

**Failures leave the session usable.** If the clone cannot be made (unreachable remote,
unknown base branch), what was created is removed again (`addition_state` `failed`, nothing on
disk); if the setup script fails or times out, the clone stays but is not given to Claude
(`held`). Messages still go to Claude, and Claude's tool result says the repository is not
available. A banner above the input (like the one for a failed setup at session start) offers
Retry or "Run setup again", "Use anyway" (held only) and Remove, which removes the clone with
the usual safe removal and forgets the repository
(`POST /api/sessions/:id/repositories/:repositoryId/addition/retry|accept|remove`). An addition
cut off by a server stop is rolled back on the next start and marked failed. Removing a
repository Claude works in is not supported.

`GET /api/repositories` lists each repository with its session clones from the database and
from `sessions/<slug>/<owner>/<repo>` on disk. Clones without a session are marked orphaned,
clones a session expects but that are gone are marked missing; clones of unregistered
repositories and unused scratch directories are listed as stray. Removing a session clone
(`GitService.removeSessionClone`) is used by autoclose (see [PR automation](#pr-automation));
fast-forwarding a local project is the cleanup's "merge". Leftovers are listed with what they
hold and removed on the Workspace cleanup page (see [Managing sessions](#managing-sessions)).

Repositories registered from GitHub are cloned and fetched with installation tokens (see
[GitHub](#github)). Repositories registered by clone URL use whatever git credentials the
API's environment has (on the NixOS service the user's SSH keys and agent and the system's
git configuration; the API's own `API_GIT_CONFIG_GLOBAL` replaces `~/.gitconfig`, so the
user's credential helpers such as `gh auth setup-git` do not apply to mirrors), so public HTTPS URLs and local paths work out of the
box. Clone URLs are validated (https, ssh, scp-like `git@host:owner/repo` or an
absolute local path; no credentials in the URL, no other transports); git always runs with
argument arrays and `--` before user values, without prompts and without repository hooks.

### Several pull requests at once

A session can work on several pull requests of one repository in parallel, each in a clone of
its own: Claude calls the tool `add_branch` (`repository` as `owner/name`, optional when the
session has one repository; optional `base_branch`, default the base of the repository's first
clone; `reason`, shown in the history). It never asks (the owner's decision: it only clones a
repository the session has already; pushes and pull requests ask as before) and is offered
to every process like `add_repository` (a repository may come later); it refuses repositories
the session does not have and local projects without remote (their branches never become pull
requests). The new clone is an addition like the ones above (fetch, clone from the freshly
fetched mirror, setup script, given to the running process), on a numbered branch
`claude/<slug>-2`, `-3`, … (no content in branch names) at
`sessions/<slug>/<owner>/<name>-2`. The number is the lowest one no clone of the session has
or had (removed ones included, as their branch may still be a pull request's head); a clone
that could not be made is forgotten at once (nothing is on disk, Claude is told and may try
again), so its number is free again. Only an addition still being prepared stands in the way
of another. Claude also uses it for the next pull request after one was merged, instead of
rewriting the session branch.

Each clone is a directory with its own branch, so the per-directory logic is unchanged (push,
session diff, PR automation, CI waiting, cleanup). Where a clone is found by repository, the
branch decides (`apps/api/src/app/sessions/session-clones.ts`): a pull request belongs to the
clone on its head branch; the routes per clone (push, create PR, clone loss, discard, addition
actions, file diff) take `?branch=` (the web app always sends it), required when the session
has several current clones of the repository (400 naming the branches otherwise; removed
further branches do not count); `create_pull_request` takes `branch` likewise (its approval
shows the head branch, nothing when the call names none and there are several). Tools that name a pull request by number find the clone
through it. The git panel shows each clone with its branch and its own pull requests. A
session has at most 10 clones in all.

When the pull request of a clone is merged or closed, no other open pull request comes from
it and the session has another directory Claude works in (the session's last one always
stays), the clone is removed once the
session's turn is over (as autoclose waits), unless it has work that is not on GitHub (the same
check as autoclose's): the history notes "removed the clone of … on …" or, with a warning,
that it was kept and why (also when a turn started while it was checked). The removed clone
is `retired` (`addition_state`): it does not keep the session from being continued, is not
given to Claude Code any more (an idle process is closed so that the next one starts without
it), and is not listed in the session diff; Claude is told with its next message. When it is
Claude Code's working directory, the app first switches to another (another clone of the
repository, else the first directory left) and tells Claude so. Its pull requests stay listed
under the repository's first clone left, with their branch, or, when no clone of the
repository is left, in a group of their own (repository name, branch). Dev servers and
previews are not tracked per directory, so ones started in the clone keep running (the note
asks Claude to stop them). Database:
`session_directories` is unique per session, repository and branch (migration
`0018_session_branches`).

### Switching the working directory

Claude Code reads `CLAUDE.md`, settings, hooks, skills and slash commands of its working
directory; the other clones are additional directories. Claude makes another clone the working
directory with the tool `switch_directory` (`repository`, optional with one repository;
`branch`, needed when the repository has several clones), e.g. when the work goes on mainly in
a clone from `add_branch`. It never asks (it only restarts Claude Code in a directory of the
session). The choice is stored at once (`sessions.working_directory`, the directory's
position, migration `0019_working_directory`; `null`: the first directory) and applies once
the process can restart: it is closed as soon as no turn runs and nothing keeps it
(background tasks, Claude's own wait with `set_waiting_state` `work`, previews of its dev
servers would end with it), so when the turn ends, at once while idle, or after the
background work (`restartPending`); the next message starts Claude Code in the new
directory, resuming the same conversation (`resume` with the session's ID). A process that
starts for another reason (e.g. after a crash) has the new directory already. The
auto-memory follows the working directory's repository, `@` mentions are relative to it, and
the session details and git panel mark it ("working directory").

Claude Code keeps the transcript in the project folder of the directory it started the session
in and finds it by ID from any working directory (tested with Claude Code 2.1.322, also the
Agent SDK's bundled one): it goes on writing there and records the current `cwd` per entry, so
nothing is copied. The app reads it from the first directory's project folder
(`transcriptDirectory`), and only for a session whose working directory was switched also from
any other project folder; deleting a session removes Claude Code's files by ID across all of
them.

Every clone is removed after its pull request (see above; the owner's decision: also a
repository's only clone, e.g. the session's first or one added with `add_repository`; the
rule is `retiresAfterPullRequest` in `apps/api/src/app/sessions/session-clones.ts`), as long
as another directory Claude works in remains. When it is the working directory, the app
switches away first; while the process must stay for background work or previews, the close
stays unhandled until it is free. If removing the files fails, the clone stays the working
directory and Claude is told nothing. Closes that earlier versions left unrecorded count as
handled (migration `0020_record_old_closes`, except those autoclose still has to handle), so
the first poll after the update removes no clones of older sessions.

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
  the session instructions ask to push only the session branch unless the user asks for more.
  The
  serialization is per API process; two API instances on the same workspace are not
  supported. Joining a running fetch can miss a commit pushed after that fetch started.
- **Auto-memory is per repository**, not per session clone: Claude Code would keep it per
  working directory; the app sets `autoMemoryDirectory` to `MEMORY_DIR/<repository id>` of the
  working directory's repository
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

| Permission      | Access     | Used for                                                                                                                                                                 |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Metadata        | read       | listing the installations' repositories                                                                                                                                  |
| Contents        | read/write | cloning, fetching and pushing; merging pull requests; reading refs when creating pull requests; the repository activity (pushes) before resolving review threads unasked |
| Pull requests   | read/write | creating, reading and merging pull requests; replying to and resolving review threads; PR automation (reviews, review comments)                                          |
| Workflows       | read/write | pushing commits that change `.github/workflows` (only then requested)                                                                                                    |
| Administration  | read/write | creating repositories for local projects (organizations)                                                                                                                 |
| Issues          | read       | `#` references: issues, comments, search; PR automation (conversation comments of pull requests)                                                                         |
| Checks          | read       | PR automation and the checks shown with each open pull request (check runs of the head commit)                                                                           |
| Commit statuses | read       | PR automation and the checks shown with each open pull request (statuses of the head commit)                                                                             |
| Actions         | read       | PR automation: logs of failed GitHub Actions jobs                                                                                                                        |

Session processes get narrower tokens of their own (see
[GitHub tokens in the container](#github-tokens-in-the-container)). The app checks its own settings against
this list (`apps/api/src/app/github/required-setup.ts`): once at startup, logging a warning per
permission or webhook event the app lacks or an installation has not accepted yet, and with every `GET /api/github/status`, shown on the Settings page (its Refresh reads GitHub
again with `?refresh=1`, past the short caches).
`GET /app` gives the app's permissions and webhook events, `GET /app/installations` what each
installation accepted; an installation that has not accepted new permissions yet (GitHub asks
the account's owner after the app's settings changed) is named with what it lacks. With a
webhook secret the webhook events of [PR automation](#pr-automation) are checked as well. Install the app
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
| merge a pull request (automerge, Claude)  | `pull_requests: write` + `contents: write`                                   |
| create a repository                       | `administration: write`, fresh, revoked afterwards                           |
| `#` references: issues, comments          | `issues: read` + `pull_requests: read`                                       |
| `#` references: a pull request's diff     | `issues: read` + `pull_requests: read` + `contents: read`                    |
| PR automation: reading state and feedback | `metadata`, `checks`, `statuses`, `pull_requests`, `actions`, `issues`: read |

If the installation of a repository changed (app reinstalled), the current one is looked up
and stored. On the NixOS service sessions never get installation tokens: git and `gh` in a
session use the user's own credentials (see [Push and pull requests](#push-and-pull-requests)).
In the container they get narrow ones of their own (see
[GitHub tokens in the container](#github-tokens-in-the-container)).

### Commit identity

Commits in session clones are made as the user, not as the app: the git author name and email
come from the API's environment (`CRM_GIT_AUTHOR_NAME`, `CRM_GIT_AUTHOR_EMAIL`, both or
neither; an invalid value stops the start) and are shown read-only on the Settings page
(`GET /api/settings`). They are written into every session clone (`user.name`, `user.email`,
`user.useConfigOnly`); at startup, before sessions resume, every existing clone with another
identity gets the current one. While they are not set, sessions with repositories and new
local projects are refused with a message naming the variables; a clone whose identity was
cleared cannot commit at all (git's global identity is hidden). Scratch sessions need none.

### Push and pull requests

Both work two ways:

1. **By button** (session view, per repository): "Push" pushes the session branch (no force,
   set as upstream); "Create PR" creates a pull request with title, description, base branch
   and draft flag, pushing first when GitHub lacks the latest commit. The click is the user's
   approval. Repositories registered by clone URL push with the server's own credentials;
   local projects have no remote (put them on GitHub first).
2. **By Claude**: in the container, `git push` gets an installation token from the API (see
   [GitHub tokens in the container](#github-tokens-in-the-container)). On the NixOS service it
   runs with the credentials of the user the sessions run as, like in a terminal: the user's git configuration (`~/.gitconfig`),
   credential helpers such as `gh auth setup-git`, SSH keys and agents. `origin` of a clone of
   a GitHub repository is its HTTPS clone URL, so the user's helper for `https://github.com`
   applies (or a URL rewrite such as `url."git@github.com:".insteadOf` in their configuration).
   The app sets no credential helper in clones; clones made by earlier versions lose the app's
   old one (it hid the user's) when their session's next Claude Code process starts. Pull
   requests come from the tool `create_pull_request` (repository, title, body, base branch,
   draft), which never pushes and makes the pull request with the GitHub App, so the session
   shows it and the PR automation follows it. Claude may use `gh` as well (read only in the
   container). Review threads of the session's own pull requests (`record.pullRequests`)
   are answered with the tool `reply_to_review_thread` (repository, pull request, the REST ID
   of any review comment of the thread, a Markdown reply and/or `resolve`): the API posts
   the reply (`POST /repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies`) and
   resolves the thread (GraphQL `resolveReviewThread`, the thread found through
   `reviewThreads` by the comment's `databaseId`) with an installation token for exactly that
   repository and `pull_requests: write`. Other pull requests are refused. It asks as the
   permission mode says (the dialog shows the pull request, the comment, the reply and
   whether it resolves); during an Autofix run replies run unasked, resolving only after a
   push in this run since the thread's last comment (see Autofix runs above). Pull requests
   of the session are merged with the tool `merge_pull_request` (repository, pull request,
   optional `method`): the API merges exactly the head commit (`PUT .../pulls/{number}/merge`
   with `sha`; without `method` rebase, else squash, else a merge commit, as automerge does)
   with an installation token for that repository, and records the merge at once. Where the
   base branch requires a merge queue it adds the pull request to the queue instead and says
   so (see [Automerge](#automerge), merge queues); `method` does not apply then. Other pull
   requests are refused. It asks as the permission mode says (the dialog shows the pull
   request and the method). When automerge is on for the pull request, a PreToolUse hook lets
   it run unasked (before the mode and rules) if the pull request is ready as automerge sees
   it, read fresh from GitHub: open, no draft, automerge not paused, all checks of the head
   commit passed (at least one reported), nobody who counts requests changes, no new reviews
   or comments since the last autofix run, no unresolved review thread; it then merges
   exactly the head commit it checked, after checking once more right before merging (no
   change request, thread or pause since, the same head). Not in `plan` mode; a check that
   takes longer than a minute leaves the call to the mode. Feedback already handed to a running
   Autofix run no longer blocks it, as for the app's own automerge after the run. Autoclose
   after a merge (also one on GitHub) waits until the session's turn is over (not while an
   approval waits), so Claude's own merge does not end the turn it runs in; the close stays
   unhandled until then (`close_handled_at`), and the first poll after a restart picks up
   such closes.

**CI checks**: every open pull request of a session shows the checks of its head commit
(check runs and commit statuses), with or without PR automation: one line with the overall
state and counts ("Checks: 1 failed, 2 running, 5 passed") that opens the list of single
checks (state, name, link to the details), failed first, then running. The API stores them
per pull request (`PullRequestDto.checks`) and reads them when a pull request is created or
read with a new head commit, on webhook deliveries about checks and statuses (debounced,
skipped when the PR automation read them meanwhile), with the PR automation's own reads, and
every 30 s for sessions an active client shows: running checks for an hour after the commit's
checks were first read, a commit without checks for 5 minutes, otherwise every 5 minutes.
Neither check changes nor re-reading an unchanged pull request move the session up the list.

Approval: both are tool uses like any other; whether they ask depends on the session's
permission mode and rules (see [Approval requests](#approval-requests)): `default` asks for
each, "allow for this session" can cover them, `auto` lets the classifier decide,
`bypassPermissions` runs them without asking, also during an Autofix run.

When Claude Code asks, the approval request carries, for every `git push` in a Bash command,
what it would update (`gitPushes`: remote, destinations, force, deletes, all branches or tags,
and whether it pushes only the session branch, with warnings otherwise;
`apps/api/src/app/agent/git-push-analysis.ts`), so the approval dialog can warn: the user's
credentials can write the whole repository, including e.g. `git push origin HEAD:main`. After
a `git push` of Claude's finished (asked or not), the app records what reached the remote from
the clone's remote-tracking branch.

Sessions are not separated from each other or from the app: they run as one user, so a
process of one session can read another session's clones, the database and the app's
secrets. Claude Code asks before reading outside the session's directories in the modes that
ask.

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

Per open pull request of a session the session view (git panel) offers three switches, all
off by default, with what started the last run,
"Stop autofix" while a run goes on, and what automerge waits for
(`apps/api/src/app/pr-automation`).

- **Autofix**: a failed CI check of the pull request's current head commit, or new review
  feedback from someone with write access to the repository, continues the session with what
  failed or what the reviewers wrote. Claude fixes it, commits and pushes the session branch.
  When GitHub reports merge conflicts with the base branch (`mergeable: false`, read with the
  pull request; while GitHub computes it, the app looks again after 10 seconds, up to three
  times per head commit), a run asks Claude to rebase onto the latest `origin/<base>`, resolve
  the conflicts and push with `git push --force-with-lease` (see
  [git during autofix](#git-during-autofix)); once per head commit,
  with failed checks and feedback of the commit along as context. A commit with merge
  conflicts is never "ready": automerge waits ("merge conflicts with main") instead of
  trying a merge GitHub would refuse.
- **Autoclose**: when the pull request is merged or closed and the session has no open pull
  request left, the session ends, its dev servers stop (`DevServers.stopSession`: its
  previews and the processes behind them) and its clones are removed, except clones with
  work that is not on GitHub.
- **Automerge** (turns autofix on with it; autofix off turns it off): the app merges the pull
  request itself once it is green, approved and without unresolved review threads; findings
  are worked off by autofix first (see [Automerge](#automerge)).

Claude switches them too, with the tool `set_pr_automation` (repository, pull request,
`autofix`, `automerge`, `autoclose`; omitted switches stay): for the session's own open pull
requests, as the switches do (`PrAutomationService.setAutomationByClaude`); switches already
as asked are left alone. It asks as the permission mode says (the dialog shows the pull
request and each switch it sets), and the session's history notes each change. It only turns
switches off during an Autofix run (from its message to the end of the turn it started,
also after a reopen), and never turns automerge on while it waits for the owner's decision
(`request_owner_decision`; turning automerge off keeps that wait). Only the Autofix turn is
guarded this way: GitHub's text stays in the conversation, and in later turns (or what Claude
reads with `gh`) the permission mode is the only guard, as for `merge_pull_request`.

### Where events come from

GitHub's state is the source of truth: webhook deliveries and polling only say _when_ to look.
A check (`PrAutomationService.check`) reads the pull request through the API with an
installation token for that repository (`metadata`, `checks`, `statuses`, `pull_requests`,
`actions`, `issues`: read), stores state and head commit, and acts. Checks of one pull request run one
at a time; one asked for meanwhile runs afterwards.

- **Webhook** `POST /api/github/webhook` (the GitHub App's webhook, events `pull_request`,
  `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`
  (resolved or unresolved threads, for automerge), `issue_comment` (only comments on
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
  opened.

### Autofix

- **What counts**: failed check runs (`failure`, `timed_out`, `startup_failure`) and commit
  statuses (`failure`, `error`) of the head commit GitHub reports now; failures of older
  commits are stale and ignored, checks that are queued or running are not failures. Reviews,
  review comments and comments in the pull request's conversation created after autofix was
  turned on (or after the last run), by users
  whose permission on the repository is admin, maintain or write
  (`GET /repos/{owner}/{repo}/collaborators/{user}/permission`), or by a bot listed in
  `PR_TRUSTED_BOTS` (e.g. a reviewer bot; list only dedicated reviewer apps, not
  `github-actions[bot]`, whose text any workflow can write); other bots (the app itself, Actions, other apps)
  and everybody else never start a run. Approvals and empty reviews ask for nothing and start
  no run; the text of an approval goes along as context of the next message.
- **Coalescing**: one run handles everything that is current: all failed checks of the head
  commit and all new reviews and comments, also when a review comes with ten comments or both
  arrive together. While other checks of the head commit are still queued or running, failures
  and feedback wait for them (at most 30 minutes after they were first seen), so a reviewer
  bot's comments, posted while its own check still runs, end up in the same run as the
  checks' results. A head commit's failures start at most one run; feedback is new only once.
- **Ready to merge**: once all checks of the head commit have finished with `success`,
  `neutral` or `skipped` (a cancelled check is not passed) and
  the commit is approved (the latest approving or change-requesting review of someone who
  counts as above approves exactly the head commit, and nobody who counts requests changes;
  with automerge on, no approval is needed: at least one check reported and nobody who counts
  requests changes), the app tells the session so in its own words, once per head commit
  (`autofix_ready_sha`). New reviews and comments go along as untrusted context; the message
  asks Claude to address what should be changed, or else to merge with `merge_pull_request`
  if the user asked for that (asked as the session's permission mode says), or to tell the
  user. The last trigger shows as "ready to merge". A check that never
  finishes (a status stuck at `pending`, a job waiting for an environment approval) delays
  feedback by the full 30 minutes and keeps the pull request from being ready. Drafts,
  conflicts or branch protection are not looked at: GitHub may still refuse the merge.
- **Busy sessions**: a run starts only while the session waits for a message (not while a
  turn runs, an approval, question or plan waits, the first message is held back, or the
  session is finished or failed). Events meanwhile are not queued: when the session waits for
  a message again, the pull request is checked again and one run covers what is still
  current then (stale CI results are dropped on the way). The owner's own messages are never
  held back by the automation.
- **The run**: a message composed by the app (`origin: 'app'`, shown in the history as "Sent
  by the app · PR automation"): fixed text with the repository, the pull request
  number, the head commit and the session branch, nothing written by others. The failed
  checks (name, conclusion, output title and summary, and for GitHub Actions jobs an excerpt
  of the job's log: colour codes and timestamps removed, from before the first to after the
  last `##[error]` line, at most 150 lines / 12,000 characters, read from at most the last
  256 KiB of the log) and the review feedback (author, state, file and line with the end of
  the diff hunk, each at most 4,000 characters, the latest 50) go as untrusted context
  (`SessionsService.sendMessage` with `untrusted`, see [Untrusted content](#github-references-123)),
  at most 60,000 characters with a note on what was left out.
- **No attempt limit** (the owner's decision, 2026-11-26): autofix starts a run for every new
  trigger (each new failing head commit, new feedback, conflict or queue removal) without
  counting; once per head commit and trigger as described above. The columns of the former
  limit (`autofix_max_attempts`, `autofix_attempts`, `autofix_gave_up_at`) stay unused.
- **Stop autofix** stops the running turn and turns autofix off for that pull request.
- **Several pull requests** (one per repository): switches and runs are per pull
  request; a session runs one autofix run at a time, the others wait until it is idle again.

### Automerge

Automerge works through autofix; turning it on turns autofix on, turning autofix off (also
"Stop autofix") turns it off. Turning it on (again) lifts a hold and retries a refused merge.

- **When it merges**: in a check, once the head commit is ready as above (all checks passed,
  nobody who counts requests changes; no approval needed, the owner's decision; at least one
  check reported, so a fresh push whose checks GitHub does not list yet is not green), no
  failed check or new review or comment waits for a run, the
  pull request is no draft, Claude did not ask for the owner's decision, GitHub did not
  refuse this head commit before, and **no review thread is unresolved** (GraphQL
  `reviewThreads`, as REST has no resolution state; every unresolved thread counts, also
  hints and threads of people without write access; when they cannot be read, nothing is
  merged and the view says so). The session must wait for a message when the merge starts
  (the merge is pinned to the checked commit, so a later push cannot slip in). The app merges
  with `PUT …/pulls/{number}/merge` and `sha` set to the checked head commit (GitHub refuses
  if it moved), trying `rebase`, then `squash`, then `merge` (the next one only when GitHub
  says the method is not allowed or the branch cannot be rebased). The merge is then seen like
  any other: notification "Merged", autoclose if on. The history says how it merged.
- **Findings first**: unresolved threads on a ready head commit go along with the
  ready message (once per head commit, as untrusted context, only those whose author counts),
  which asks Claude to fix every finding, also
  hints, commit and push, then reply on each thread with what changed and resolve it with
  `reply_to_review_thread` (the context gives each review comment and thread its
  `comment-id`); findings it does not fix get a reply with the reason and stay unresolved.
  The reviewer's next review starts the next round.
  The UI shows "Automerge waits: 2 unresolved review threads". Messages to Claude while
  automerge is on say that the app merges and that Claude's own `merge_pull_request` runs
  unasked only once the pull request is ready that way (see
  [Push and pull requests](#push-and-pull-requests)); threads of people the app does not
  trust are left to the owner, without replying to or resolving them.
  After a run ends, the pull request is checked again (nothing left may mean ready). When
  threads stay open that no run works on (Claude left them without asking the owner, or none
  of them is by someone who counts, whose text never reaches Claude), the owner is notified
  once per head commit ("Automerge is stuck").
- **The owner's decision**: when a finding needs the owner (a product or design decision, a
  trade-off, scope, or Claude thinks it is wrong), Claude calls the app's tool
  `request_owner_decision` with its question (offered to sessions with a GitHub clone; never
  asks, also not during an Autofix run, as it only stops a merge). It pauses automerge of the
  session's open pull requests (`automerge_held_at`), notes it in the history, and notifies the
  owner ("Automerge needs you", with the question). The owner's next message in the session
  (`SessionsService.send`, not the app's) lifts the hold; the pull request is checked again
  when that turn ends.
- **Refusals**: refusals that may pass by themselves (409, "Base branch was modified", "not
  mergeable" while GitHub computes mergeability, GitHub unreachable) are retried up to three
  times, two minutes apart. When GitHub still refuses (conflict, branch protection, workflow
  files the app may not merge), the head commit and GitHub's reason are stored, the history says so, the owner is
  notified once, and the session's ready message says it was refused. A new head commit, or
  turning automerge off and on, tries again.
- **Merge queues**: where the base branch requires a merge queue (a branch rule or
  ruleset; GitHub refuses the direct merge with 405 "... through the merge queue"), automerge
  and Claude's `merge_pull_request` add the pull request to the queue instead (GraphQL
  `enqueuePullRequest` with `expectedHeadOid` set to the checked head commit; at the end of
  the queue, never `jump`: the owner's decision); the queue's settings decide the method. A
  pull request already in the queue stays where it is. The app stores the queued head commit
  (`merge_queued_sha`), and while it is set reads the entry with each read of the pull
  request (GraphQL `mergeQueueEntry`: place, state, the merge group's commit) and follows the
  pull request by polling and webhooks even without autofix or autoclose. The view shows "In
  queue #2" and the history notes the enqueue; automerge does nothing more for that head
  commit and the session gets no ready message for it. The queue's merge is seen like any
  other merge (notification, autoclose, wake). When the queue removes it without merging it
  (the latest `RemovedFromMergeQueueEvent` after the enqueue, with GitHub's reason; a removal
  dated by GitHub against the time GitHub gives for the enqueue; a removal not listed yet
  changes nothing until the next read, except after a push, and three reads in a row that find
  it in no queue over at least five minutes count as a removal with an unknown reason): if the head commit
  changed since the app added it (a push), the history only says so and automerge adds the new head commit once it is ready.
  Otherwise, as for failed checks (the owner's decision): with autofix an Autofix run starts
  (trigger `queue`) with the reason in the app's text (only GitHub's enum names,
  in plain words) and the failed checks of the merge group's commit (with job logs) as
  untrusted context; automerge does not add that head commit again (as for a refused merge,
  the next head commit or turning it off and on tries again) and no ready message follows for
  it. Without autofix the history says so and the owner is notified
  ("Removed from merge queue"); without autofix Claude is also woken if it said it goes on by
  itself (after the end of a turn during which the removal came). Adding the same commit again
  (with approval) makes an earlier removal moot. Whether the GitHub App needs the repository permission "Merge queues" for
  `enqueuePullRequest` is not documented by GitHub; a refusal "not accessible by integration"
  names it in the error.
- **Known limit (decided)**: green checks, no change requests and the resolved threads are
  the gate (approval is not needed), and the owner's own approval counts where reviews are
  required. Sessions run as the owner's user, with the owner's GitHub
  credentials (`gh`) where the machine has them, so in any turn (e.g. in `auto` mode, also
  during an Autofix run) Claude could approve or resolve threads as the owner. That Claude must
  not do so is only an instruction in the app's messages, not enforced. Where that matters,
  keep the session user without GitHub credentials or leave automerge off. In the container
  sessions cannot approve (`gh`'s token is read only, approvals by bots
  count only when listed in `PR_TRUSTED_BOTS`; never list the app's own bot there); they can
  resolve threads of their own pull requests, but only through `reply_to_review_thread`
  (the owner's decision), which outside Autofix runs asks as the session's permission mode
  says (`auto` may not ask, `bypassPermissions` never does), during them only after a push
  in the run since the thread's last comment, and shows in the history. The
  `git` token's `contents: write` can merge a pull request or push to the default branch
  directly (e.g. with `curl` and the token from `git credential fill`). The gate therefore
  holds only together with branch protection on GitHub (required reviews and checks, no
  bypass for the app).

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
- **Force push in a conflict run.** While a run for merge conflicts goes on (from its message
  to the end of its turn), `git push --force-with-lease` (plain, optionally with
  `--force-if-includes`; no `-f`/`--force`, `+` refspec or lease value) of the session branch
  is accepted too, only for the clones of pull requests in such a run. The app pushes it
  itself with `--force-with-lease=refs/heads/<branch>:<commit>`, the commit being the clone's
  `origin/<branch>` (what Claude last saw on GitHub), and only when the branch contains the
  base branch's commit as GitHub reports it right then (not the clone's `origin/<base>`, which
  the session can set); when its workflow files differ from that commit's (compared as trees,
  so merge commits count too), the push asks. Only while the run's turn really goes on, only
  with `--force-with-lease` itself, and only for the clone's branch (`HEAD` or its name). Outside such a run any force push asks as the permission mode
  says. The rebase itself (`git fetch`, `git rebase`, `git rebase --continue`) follows the
  permission mode like every other command.

**Hooks and configuration.** A commit would normally run the clone's hooks, and `git add` can
run clean filters, fsmonitor or signing programs named in git configuration. These are code
from the clone that Claude itself can write, so running them without approval would let any
command run unapproved. The app therefore runs these commands with hooks off
(`core.hooksPath=/dev/null`, as all its git commands), without global and system
configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; the session user's own
`~/.gitconfig` is Claude's to write), with fsmonitor and commit signing off, and only when the
clone's own configuration holds nothing but what git and the app write there (core basics,
`remote.origin`, `branch.*`, identity, the old credential helper); otherwise it asks. Repository
hooks such as linters therefore do not run for autofix commits (`--no-verify` is accepted, as
it changes nothing); CI checks the result.

**What Claude and the owner see.** Claude Code runs only a command that prints the app's
report (`printf … | base64 -d`, failing with exit status 1 when a step failed), so Claude gets
the real output of every step and a failure never looks like success. The history shows the
tool call as "done by the app" or "failed" with what the app did ("Staged; Committed; pushed
… at …"), from a stored `tool.by_app` event that survives reloads and restarts. The chosen
permission mode is never changed by the automation; a session in `auto` or
`bypassPermissions` runs an Autofix run in `default`, and in every mode each call of the run
but reading asks the owner, also where allow rules would let it through (nothing runs without
the owner while Claude works on GitHub content, apart from the git commands above) and returns to its mode
when the run's turn ends; the view says so ("Ask (Autofix run)").

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
   comment, Pull request, Pull request review, Pull request review comment, Pull request
   review thread and Status. Without Pull request review thread, a thread the owner resolves
   is noticed with the next other event or poll.
3. In Cloudflare Access: a Bypass policy (or a separate application with a Bypass policy) for
   exactly the path `/api/github/webhook` of the public host, nothing else. Without it GitHub's
   deliveries end at the Access login; polling still works then, at its slower backstop
   interval.
4. Check the delivery log on GitHub ("Recent Deliveries"): `ping` should answer 200.

Without a webhook (no secret) everything works through polling every two minutes.

## Independent review

A second Claude reviews a session's changes without knowing the session's conversation, and
its findings go to the session's Claude to fix (`apps/api/src/app/reviews`).

- **The reviewer** is a Claude Code process of its own that the API starts
  (`AgentRunner.review`, `buildReviewQueryOptions`), as the session user like a session: in
  the session's clones, with only `Read`, `Grep` and `Glob` (the `tools` option, so no other
  tool exists) and no allow rules: reads inside the session's directories need none, and
  `dontAsk` refuses everything else, also reads elsewhere such as the Claude login (checked
  with Claude Code). No MCP servers, claude.ai connectors or hooks (`disableAllHooks`: the
  reviewed changes may have written the project's settings), no transcript
  (`persistSession: false`), the chosen model and effort, and a JSON schema for
  its answer (`outputFormat`). Settings and CLAUDE.md files load as for a session. Its
  prompt is the session diff (`SessionDiffService`: every clone against the merge base with
  its base branch, with uncommitted and untracked files) as patches up to about 400 000
  characters; files beyond that are listed for it to read. Nothing of the conversation goes
  to it.
- **Settings:** `GET`/`PUT /api/settings/review` (`app_settings` key `review`): model
  (default `claude-fable-5-2`), effort (default `high`), on the Settings page (a stored
  `maxAutoRounds` of the former round limit is ignored). Per session (`PUT /api/sessions/:id/review-settings`,
  in the session's details): the review mode (`sessions.review_mode`), and a model and effort
  of its own (`null`: the app's default).
- **Starting:** `POST /api/sessions/:id/review` ("Review now" in the session's details) starts
  one at once, also while Claude works; 409 while one runs or when nothing changed.
  `DELETE /api/sessions/:id/review` cancels it; after 30 minutes it fails, and archiving the
  session cancels it. One review per session at a time; it counts as running until its
  findings were delivered.
- **Review mode** per session: `off` (only "Review now"), `claude` (the default: Claude asks
  with the app tool `request_review`) or `turn` (after every turn, see below, and when Claude
  asks). Sessions that had auto-review on became `turn` (migration 0024).
- **Claude's requests:** the tool `request_review` (no approval needed; offered in every
  session, since the mode can change while the process runs) starts a review and returns at
  once. Claude always hears the outcome as the app's message: the findings, or that there were
  none, or that the review failed or was cancelled (so Claude, waiting before its pull
  request, goes on). `claude-md/core.md` tells Claude to ask after a finished, locally
  checked work package, before a pull request or push. The tool refuses while a review runs,
  without changes, for a diff already reviewed (same fingerprint as below), without a
  repository, or with mode `off`.
- **Auto-review** (mode `turn`): when a session's turn is over (it waits for a message, or
  only for what Claude goes on with by itself) and the fingerprint of its diff's content
  (`sessions.reviewed_diff`; not commits or line numbers, so committing or rebasing reviewed
  changes does not count) changed since the last review, a review starts (also once a review
  ends that ran while the turn ended), also after the turns that fix findings.
  There is no round limit (the owner's decision, 2026-11-26): rounds with findings are not
  counted (`sessions.auto_review_rounds` stays unused), and reviews go on until one finds
  nothing or the diff stops changing.
- **Findings** go to Claude right away as the app's message ("An independent review …",
  shown as "Sent by the app · Review"), queued while a turn runs; the findings themselves go
  along as untrusted context (the reviewer read repository content). Without findings Claude
  gets nothing, except for a review it asked for. The history shows a card per review
  (`review.started`, `review.finished`):
  running with Cancel, the findings, the summary, an error, model, effort, duration and
  cost. A review cut off by a server stop shows as interrupted. Findings never go to an
  archived session, and those of a review that started by itself (auto-review or Claude's
  request) not to a session that ended meanwhile (a manual review's resume it).
- **Usage** of the reviewer counts for the session (`usage_records.review_id`), but not as the
  baseline the session's own Claude Code totals start from.
- While a review runs, or auto-review is about to start one, the PR automation waits: no
  autofix run, no merge (`SessionAutomationHooks.reviewBusy`), and Claude's
  `merge_pull_request` asks as the mode says instead of merging unasked.

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
The Settings page shows them in its Server card: the version, or the image tag
`sha-<short commit>` for untagged builds (`0.0.0`), the short commit and the commit time as
`yyyy-MM-dd HH:mm` in the server's time zone (`TZ`, else UTC; reported by the authenticated
`GET /api/settings`, not by the public health check).

The image (linux/amd64, Debian based) contains Node.js 24, git, `gh` (wrapped, see
[GitHub tokens in the container](#github-tokens-in-the-container)), openssh-client, curl, the
Claude Code CLI and Nix (single-user, flakes enabled). The `claude` command is the native
binary that ships with the Agent SDK, so the CLI and the sessions always use the same version.
It listens on port 8080.

### Users and what sessions can reach

The image keeps the app's own data away from the sessions with
`PROCESS_ISOLATION=separate-users` (the NixOS service runs everything as the owner's user
instead):

| User     | UID (build arg)   | Runs                                              | Owns                                                        |
| -------- | ----------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `crm`    | 1000 (`API_UID`)  | the API                                           | `/data/db` (0700), `/data/git` (0700), mirrors, GitHub key  |
| `claude` | 1001 (`USER_UID`) | Claude Code, setup scripts, git in session clones | `/data/claude`, `/nix`, session clones, scratch directories |

The container starts as root only for the entrypoint (`docker/entrypoint.sh`): it gives the
volumes these owners (also volumes of older images), checks that the session user cannot read
the GitHub App key, and starts the API as `crm` with exactly the capabilities CHOWN,
DAC_OVERRIDE, KILL, SETGID and SETUID (ambient, through `capsh`; do not drop them from the
container). The API starts every session process through `setpriv` as `claude`, with all
capabilities dropped and `no_new_privs`, and with an environment built from an allowlist
(`SESSION_ENV_ALLOWLIST` in `apps/api/src/app/common/process-isolation.ts`); its own git
commands on the mirrors run without capabilities too. It refuses to start as root or without
the capabilities.

Sessions get the image's `PATH`, which starts with the session user's Nix profile
(`SESSION_PATH`, set by the entrypoint). The API's own `PATH` holds only root-owned
directories, and it resolves `setpriv` there once at startup: a command name is otherwise
looked up in the `PATH` of the child's environment, so a `setpriv` or `git` the session user
installed into its profile would have run with the API's capabilities or as the API user.
Images before this change gave the API the session user's profile on its `PATH`.

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
  configuration), the API's `/proc/<pid>/environ`; get GitHub tokens for repositories that are
  not clones of a running session, or `gh` tokens that can write; write or delete in the mirrors; call the
  management API (refused by peer user, see [Authentication](#authentication)); become
  another user (`setpriv`/`su` fail);
- can: its clones, `/data/claude` (login, settings, MCP servers, transcripts, memory), `/nix`,
  and everything of other sessions (same user), including their dev servers on loopback; expose ports of its own user through `expose_port` (never the
  API's or root's, see [Previews](#previews-of-dev-servers)); not open preview hosts through
  the API's port.

### GitHub tokens in the container

The session user `claude` has no GitHub credentials of its own (no SSH key, no token; its
home is not a volume). Repositories are fetched by the API (installation tokens, `/data/git`),
the Push and Create PR buttons and the tools `create_pull_request` and `reply_to_review_thread`
use the GitHub App, and
Claude's own `git` and `gh` get short-lived installation tokens of the app from the API
(`apps/api/src/app/sessions/session-github-tokens.service.ts`):

- Every Claude Code process of a session with GitHub repositories gets a random process
  token (`CRM_SESSION_TOKEN`, kept only as hash, revoked when the process ends) and the
  API's address (`CRM_API_URL`). Git's credential helper for `https://github.com` is set
  through the environment (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`, resetting other helpers),
  so it applies to every git command of the process without touching the clones' config.
  Both run `assets/crm-github.cjs`, which asks `POST /api/session-tokens/git` or `…/gh`.
- `git`: a token for exactly the repository of the remote (`useHttpPath`), which must be a
  ready clone of the session, with `contents: write` (plus `workflows: write` when the session
  branch changes `.github/workflows`). Whether a `git push` runs is the session's permission
  mode's decision, as for any command; the approval dialog shows what it would update. The
  token can write the whole repository (any branch, tags, releases, merging pull requests
  through the API), so protect the default branch on GitHub; that is required for the
  automerge gate (see [PR automation](#pr-automation)). `workflows: write` is added only when
  the session branch changes workflow files.
- `gh`: `/usr/local/bin/gh` (`docker/gh`) gets a token from the helper and execs Debian's
  `/usr/bin/gh` with it as `GH_TOKEN`
  for all of the session's repositories in the installation of the working directory's
  `origin` (or of the session's first GitHub repository), read only: metadata, contents, pull
  requests, issues, checks, statuses, Actions. It cannot comment, approve, merge, resolve
  review threads or change settings; replies on and resolving review threads of the session's
  own pull requests go through the app's tool `reply_to_review_thread` instead. Outside a
  session it runs `gh` without a token. A `gh`
  from a Nix shell comes first on the PATH and gets no token; commands that need a user
  (`gh pr status`, `gh auth status`) do not work with installation tokens.
- Tokens are minted for the session alone (never the API's cached ones), reused for at most
  ten minutes, and all of them are revoked when the process ends (also replaced ones; a
  request still waiting when the process ends gets none). Only session processes may call the routes
  (by peer user, see [Authentication](#authentication)), and only with a valid process token.

Repositories registered by clone URL (not GitHub) get nothing: Claude asks the user to push
with the button.

Known limit: all sessions run as the one user `claude`, so a session can read another running
session's process token from its environment (`/proc/<pid>/environ`) and get tokens for that
session's repositories. The boundary is "repositories of the running sessions", not "of this
session"; binding requests to the session's process tree would close it.

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

Claude Code uses Claude accounts (subscriptions), not API keys. Log in from the web app:
Settings → Accounts → Log in (the main account) or Add Claude account (further ones, see
[Accounts](#accounts)). The credentials are stored on the Claude volume
(`/data/claude/.credentials.json`, further accounts under `/data/claude/crm-accounts/`) and
survive restarts and re-creations of the container.

Alternatively log in the main account once inside the running container:

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

`claude-md/container.md` (the container: directory layout, Nix in the image) followed by
`claude-md/core.md` (shared with the NixOS module: directories, the session title, showing
files, previews, git)
hold the rules for all sessions in the container. The image installs them as the managed policy
file `/etc/claude-code/CLAUDE.md`, which Claude Code loads in addition to the user's
`/data/claude/CLAUDE.md`. That way it is not hidden by the Claude volume and image updates take
effect immediately, while personal additions can still go into the volume.

## Running as a NixOS service

The repository is a flake with a package (`packages.x86_64-linux.default`) and a NixOS module
(`nixosModules.default`) that runs the app as a systemd service of a user of the machine,
usually the owner's login user (`PROCESS_ISOLATION=single-user`). It is not a sandbox: every
session can do what Claude Code started by that user in a terminal can do, with the user's own
`~/.claude` (login, settings, skills, plugins, MCP servers, memory, `CLAUDE.md`), git
configuration, `gh` login, SSH keys, groups and `sudo`, on the whole machine. The app adds the
session management, per-session clones, PR automation, notifications, previews and the mobile
UI. The Docker image stays supported; both are built and tested in CI.

### Minimal configuration

```nix
# flake.nix of the machine's configuration
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  inputs.claude-remote-manager.url = "github:<owner>/claude-remote-manager";
  # Optional: build it with the machine's nixpkgs instead of the pinned one.
  # inputs.claude-remote-manager.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, claude-remote-manager, ... }: {
    nixosConfigurations.machine = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        claude-remote-manager.nixosModules.default
        {
          nix.settings.experimental-features = [ "nix-command" "flakes" ];
          users.users.alice.isNormalUser = true;
          services.claude-remote-manager = {
            enable = true;
            user = "alice";
            auth.mode = "none"; # loopback only; see the fuller example
          };
        }
      ];
    };
  };
}
```

This listens on `127.0.0.1:8080` and keeps the app's state in `/var/lib/claude-remote-manager`,
owned by `alice`. Sessions use `alice`'s Claude login: log in with `claude` as `alice` once, as
for a terminal session. Open it through an SSH tunnel, or put a tunnel or proxy with
authentication in front.

### Fuller configuration with Cloudflare Access and sops-nix

```nix
{ config, pkgs, ... }:
{
  sops.secrets = {
    # Root-owned files are fine: systemd hands them to the service as
    # credentials.
    "crm/github-app-key" = { };
    "crm/github-webhook-secret" = { };
    "crm/ntfy-token" = { };
  };

  services.claude-remote-manager = {
    enable = true;
    user = "alice";
    # With impermanence: state below the persistent volume.
    dataDir = "/persist/var/lib/claude-remote-manager";
    listenAddress = "127.0.0.1"; # cloudflared on the same machine
    port = 8080;

    auth = {
      mode = "cloudflare-access";
      teamDomain = "example.cloudflareaccess.com";
      audiences = [ "<application audience tag>" ];
      allowedEmails = [ "owner@example.com" ];
    };
    allowedHosts = [ "crm.example.com" ];
    publicUrl = "https://crm.example.com";
    preview = {
      url = "https://preview.example.com";
      accessAudiences = [ "<audience tag of the preview application>" ];
    };

    github = {
      appId = 123456;
      privateKeyFile = config.sops.secrets."crm/github-app-key".path;
      webhookSecretFile = config.sops.secrets."crm/github-webhook-secret".path;
    };
    ntfy = {
      url = "https://ntfy.example.com";
      topic = "claude-sessions";
      tokenFile = config.sops.secrets."crm/ntfy-token".path;
    };

    packages = with pkgs; [ jq python3 gnumake ];

    environment = {
      SESSION_STALL_MINUTES = "20";
      SESSION_IDLE_TIMEOUT_MINUTES = "120";
      # An SSH agent the sessions should use, if the user's SSH configuration
      # does not name one (IdentityAgent).
      # SSH_AUTH_SOCK = "/home/alice/.ssh/agent.sock";
    };

    extraInstructions = ''
      ## Home network

      - The NAS is nas.example.com (read-only share under /mnt/media).
    '';
  };
}
```

The module checks at evaluation time what the app would refuse at startup: a user the
configuration does not define, root, Cloudflare Access without team domain or audience,
previews behind Access without their own audience (or with one of the app's), ntfy without
topic or token, a GitHub key without App ID, secret files in the Nix store or as relative paths.

### Options

| Option (`services.claude-remote-manager.`) | Default                          | Meaning                                                                  |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| `enable`                                   | `false`                          | Run the service                                                          |
| `package`                                  | the flake's package              | The app                                                                  |
| `user`                                     | none, required                   | User the service and every session run as (defined in the configuration) |
| `group`                                    | the user's primary group         | Group of the service and the data directory                              |
| `packages`                                 | `[ ]`                            | Packages on the sessions' `PATH` after the user's profiles               |
| `listenAddress`, `port`                    | `127.0.0.1`, `8080`              | Where the server listens (`LISTEN_ADDRESS`, `PORT`)                      |
| `openFirewall`                             | `false`                          | Open `port` in the firewall                                              |
| `dataDir`                                  | `/var/lib/claude-remote-manager` | The app's state: `db/`, `workspace/`, `memory/`, `git/` (see below)      |
| `auth.mode`                                | none, required                   | `cloudflare-access` or `none`                                            |
| `auth.teamDomain`, `auth.audiences`        | `null`, `[ ]`                    | Cloudflare Access team domain and audience tags                          |
| `auth.allowedEmails`                       | `[ ]`                            | Optional email allowlist                                                 |
| `allowedHosts`, `allowedOrigins`           | `[ ]`                            | `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`                                       |
| `publicUrl`                                | `null`                           | `PUBLIC_URL`                                                             |
| `gitAuthor.name`, `gitAuthor.email`        | `null`                           | `CRM_GIT_AUTHOR_NAME`, `CRM_GIT_AUTHOR_EMAIL` (both or neither)          |
| `preview.url`, `preview.accessAudiences`   | `null`, `[ ]`                    | `PREVIEW_URL`, `PREVIEW_ACCESS_AUD`                                      |
| `ntfy.url`, `ntfy.topic`                   | `null`                           | `NTFY_URL`, `NTFY_TOPIC`                                                 |
| `ntfy.tokenFile`                           | `null`                           | Secret file: ntfy token                                                  |
| `github.appId`                             | `null`                           | `GITHUB_APP_ID`                                                          |
| `github.privateKeyFile`                    | `null`                           | Secret file: the GitHub App's private key                                |
| `github.webhookSecretFile`                 | `null`                           | Secret file: the webhook secret                                          |
| `github.trustedBots`                       | `[ ]`                            | `PR_TRUSTED_BOTS`                                                        |
| `vapid.privateKeyFile`                     | `null`                           | Secret file: own VAPID private key (otherwise generated into `db/`)      |
| `vapid.publicKey`, `vapid.subject`         | `null`                           | `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`                                      |
| `environment`                              | `{ }`                            | Further variables of the service and its sessions; never secrets         |
| `environmentFiles`                         | `[ ]`                            | Secret files with `NAME=value` lines                                     |
| `extraInstructions`                        | `""`                             | Markdown appended to the instructions every session gets (see below)     |

Removed in this version (evaluation fails with a hint): `sessionUser.create`,
`sessionUser.group`, `sessionUser.home`, `sessionUser.extraGroups`, `sessionUser.writablePaths`,
`hiddenPaths`, `claudeConfigDir`. `sessionUser.name` and `sessionUser.packages` are renamed to
`user` and `packages` (with a warning). The `claude-remote-manager-claude` command is gone: log
in with the user's own `claude`.

Secret files are paths as strings (for sops-nix `config.sops.secrets.<name>.path`), never
contents: nothing secret ends up in the Nix store. systemd reads them as root when the service
starts (`LoadCredential`) and gives the service copies under `/run/credentials/`. They are not
hidden from sessions: a session runs as the same user and can read them, as well as the
database (the owner's decision).

### Data directory

| Path         | Contents                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| `db/`        | SQLite database, `files/` (attachments, shown files), generated VAPID keys        |
| `git/`       | `gitconfig` of the API's own git commands on mirrors (`API_GIT_CONFIG_GLOBAL`)    |
| `workspace/` | `repos/` (mirrors), `sessions/` (clones), `scratch/`; one file system             |
| `memory/`    | Claude Code's auto-memory per repository, shared by its sessions (`MEMORY_DIR`)   |
| `claude/`    | Only from earlier versions: their Claude Code configuration directory (see below) |

Everything belongs to `user` (`dataDir` itself mode 0700). systemd-tmpfiles creates the
directories. On a machine with impermanence put `dataDir` below the persistent volume (or
persist `/var/lib/claude-remote-manager`); the user's `~/.claude` must persist as well.

### Upgrading from the version with separate users

Earlier versions ran the API as `claude-remote-manager` and sessions as a session user with a
configuration directory of their own (`<dataDir>/claude`). On the first start after the
upgrade:

- **Ownership**: a start step of the service (as root) gives the whole data directory to
  `user` (once: a stamp in `/var/lib/claude-remote-manager-owner`, writable by root only,
  records to whom; a change of `user` repeats it). Only files of other owners change, never
  through a symlink; the walk may take a while for many clones (no start timeout). The old users are no longer defined; NixOS removes them.
- **Transcripts**: Claude Code resumes a session only from its transcript in the current
  configuration directory, which is now the user's `~/.claude`. The API copies every entry of
  `<dataDir>/claude/projects/*/` (transcripts, subagent transcripts, memory of scratch
  sessions) that `~/.claude/projects/` lacks, before it resumes anything
  (`LEGACY_CLAUDE_CONFIG_DIR`); the project directories are named after the clone paths,
  which did not change. The repository memory `<dataDir>/claude/repository-memory` moves to
  `<dataDir>/memory`. Nothing is overwritten or deleted; a marker file
  (`COPIED-TO-CLAUDE-CONFIG.txt`) keeps it from running again. Remove `<dataDir>/claude` (and
  `<dataDir>/home` of a created session user) once the old sessions resume fine.
- **A `claudeConfigDir` elsewhere**: only `<dataDir>/claude` is copied from. If the removed
  option pointed elsewhere, move that directory to `<dataDir>/claude` before the first start;
  the start step then gives it to the user with the rest.
- **The login**: the old directory's login is not taken over; sessions use the user's own.
- **Session clones**: the app's old credential helper is removed from all session clones when
  the API starts (and again before a session's Claude Code starts), so the user's credentials
  apply, also to a push from a terminal in an old clone.
- **The API's SSH identity**: the API's home used to be `<dataDir>/git`; a deploy key or
  `known_hosts` in `<dataDir>/git/ssh` (for repositories registered by an SSH clone URL) is no
  longer used, mirror fetches now use the user's `~/.ssh`. Move the key there, or set
  `core.sshCommand` in `<dataDir>/git/gitconfig` (the API's `API_GIT_CONFIG_GLOBAL`).
- **Configuration**: replace `sessionUser = { name = "alice"; create = false; }` by
  `user = "alice";`, move `sessionUser.packages` to `packages`, and drop the removed options.

### Logging in to Claude

Sessions use the login of the user's `~/.claude`, like a terminal session of that user: log in
once with any Claude Code as that user (`claude`, then `/login`, or `claude auth login`). The
package's own Claude Code, the version the sessions run, is
`<package>/libexec/claude-remote-manager/claude`. Alternatively put
`CLAUDE_CODE_OAUTH_TOKEN=…` (from `claude setup-token`) into a secret file listed in
`environmentFiles`.
Further accounts are added in the web app (Settings → Accounts); they live in
`~/.claude/crm-accounts/` (see [Accounts](#accounts)), and the main account can be
logged in there too.

### The service

- **User**: everything runs as `user` with its primary group and supplementary groups: the
  API, Claude Code, setup scripts, git in session clones, dev servers. The API starts session
  processes directly (no `setpriv`, no capabilities).
- **No sandbox**: no `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
  `NoNewPrivileges`, system call filter, `RestrictAddressFamilies` or `ProtectProc`, no hidden
  paths and no mount namespace: sessions use `sudo` (as far as the user may), devices,
  containers, the whole file system and all processes, and share `/tmp` with the user.
- **Session instructions**: `claude-md/nixos.md` (this machine: paths, NixOS, what a session
  may do) followed by `claude-md/core.md` (shared with the image) and `extraInstructions`, in
  the Nix store and appended to Claude Code's system prompt of every session
  (`SESSION_INSTRUCTIONS_FILE`), on top of the user's own `CLAUDE.md` files. Not a machine-wide
  `/etc/claude-code/CLAUDE.md`, which the user's terminal sessions would load as well.
- **Restarts**: a rebuild that changes the service restarts it, which ends the Claude Code
  processes of all sessions (they resume with the next message), also of a session that ran the
  rebuild; `nixos-rebuild` itself runs the switch outside the service (`systemd-run`).
- **Refused requests**: requests from processes the service started (sessions, their tools and
  dev servers, also detached ones in the service's cgroup) are refused by the API (see
  [Authentication](#authentication)); the user's own programs on the machine are not.
- **No health check unit**: systemd restarts the service when it fails (`Restart=on-failure`);
  `GET /api/health` answers as in the container for external monitoring.

### The sessions' environment

Sessions get the service's environment (that of `user`; systemd sets `HOME`, `USER`,
`LOGNAME` and `SHELL` from the user), without the app's secrets (`CRM_SECRET_*`):

- `PATH` (`SESSION_PATH`): `/run/wrappers/bin` (`sudo`), the user's own Nix profiles
  (`~/.nix-profile`, `~/.local/state/nix/profile`), `/etc/profiles/per-user/<user>`, the
  default and the system profile (`/run/current-system/sw`), then a base of bash, coreutils,
  findutils, grep, sed, awk, tar, gzip, xz, zstd, which, ps, less, git, ssh, curl, ripgrep,
  Node.js, the machine's Nix, and `packages`. The API's own `PATH` holds store paths only.
- `LANG` and `LOCALE_ARCHIVE` from `i18n`, `TZ` from `time.timeZone`, `SSL_CERT_FILE` and
  `NIX_SSL_CERT_FILE` (the system's CA bundle), `DISABLE_AUTOUPDATER`, and whatever
  `environment` adds. Not the app's own configuration (`NODE_ENV`, `PORT`, the data
  directories, `GITHUB_APP_ID`, the pointers to its secrets, `CREDENTIALS_DIRECTORY`,
  `WEB_ROOT`, …): a session's `npm ci`
  would skip devDependencies, its dev servers would take the API's port, and a development
  API started in a session would open the service's database. No `CLAUDE_CONFIG_DIR` and no `GIT_CONFIG_GLOBAL`: Claude
  Code and git use `~/.claude` and `~/.gitconfig`.
- A systemd service has no login session: variables a login shell would set (an SSH agent's
  `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR`) are missing unless the user's configuration provides
  them some other way (SSH's `IdentityAgent`, git's credential helpers) or `environment` sets
  them. Claude Code's Bash tool runs the user's shell with a snapshot of its startup files.

**Git and GitHub**: session clones use the user's git configuration and credentials (see
[Push and pull requests](#push-and-pull-requests)); the API's own git commands on mirrors use
installation tokens and `<dataDir>/git/gitconfig`, so the user's URL rewrites or signing
settings do not change them.

### What differs from the container

- Everything runs as the owner's user, without sandbox; the container separates the API's
  user from the session user.
- No `/nix` volume and no Nix inside an image: the host's Nix and store.
- No entrypoint: systemd-tmpfiles creates the directories, systemd reads the secrets.
- Secrets may be root-owned files (they arrive as credentials).
- The session instructions describe the NixOS machine and go to the system prompt.
- The server listens on `127.0.0.1` by default (`listenAddress`).

### Updating

- **The app**: `nix flake update claude-remote-manager` in the machine's configuration, then
  rebuild; the service restarts with the new package (database migrations run at startup).
- **npm dependencies** in this repository: the package fetches the npm dependencies as one
  fixed-output derivation whose hash is in `nix/npm-deps-hash.json`. After changing
  `package-lock.json`, run `nix/update-npm-deps-hash.sh` and commit the file. The hash covers the
  lockfile reduced to this platform's packages (`nix/lockfile-filter.jq`: other platforms'
  binaries such as the Agent SDK's other Claude Code builds are not downloaded). CI fails with
  a pointer to the script when the hash is stale.
- **nixpkgs**: `nix flake update nixpkgs` here (or `follows` in the consumer); CI runs the VM
  tests against the pinned revision.

### Checks

`nix flake check` builds the package and runs:

- `vm-install`, `vm-upgrade`: NixOS VM tests with the module, the login user `alice` (wheel,
  passwordless `sudo`) and secrets as root-only files; `vm-upgrade` starts from the data
  directory of the earlier version (files of other owners, the old configuration directory with
  a transcript and repository memory). They check the service, health, web app and service
  worker, that the service runs as `alice` without capabilities, `no_new_privs`, seccomp or a
  mount namespace of its own, that the data directory is `alice`'s, that requests of `alice`'s
  own processes are answered and those of session processes (also detached ones) are refused
  over loopback and the machine's address, a local project (mirror, session clone) with a
  `bypassPermissions` session whose Claude Code is a stand-in script recording what it sees
  (the user's `PATH` with `sudo`, no `CLAUDE_CONFIG_DIR`/`GIT_CONFIG_GLOBAL`, the session
  instructions in the initialize request, `--allow-dangerously-skip-permissions`) and can do
  (`sudo`, devices, the shared `/tmp`, the user's git credential helper in the clone), the file
  helper, ending and deleting the session, `claude --version` of the package, and for
  `vm-upgrade` the ownership change and the copied transcripts and memory.
- `eval-*`: configurations the module must refuse (an undefined user, root, a removed option,
  Cloudflare Access without audience, previews without their own audience, a secret file in
  the store) and one it must accept.

Not covered by the checks: a real Claude login and turn, Cloudflare Access in front, previews on
real wildcard host names, GitHub.
