# Claude Remote Manager

A self-hosted web frontend for managing Claude Code sessions on a home server: sessions that
work on several repositories at once, each in its own git worktree, with live chat, diffs and
cleanup. Everything runs in one Docker container. See [docs/specification.md](docs/specification.md)
(German) for the full specification.

Current state: sessions run through the Claude Agent SDK in one fixed working directory and
stream to a minimal chat view; usage is recorded per request. Worktrees, the GitHub
integration, approval dialogs and the full chat view follow.

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

Start a session with a short prompt (choose Haiku to keep it cheap), watch the answer stream in,
send a follow-up, restart the API and send another message: the session is resumed. Sessions
work in `~/.local/share/claude-remote-manager/projects/scratch` by default, outside this
repository; the database lives in `data/db` of the workspace (gitignored).

Start the API from a normal shell. Started from inside a Claude Code session it inherits that
session's `CLAUDE_*`/`ANTHROPIC_*` variables and passes them on to the sessions it runs.

### Environment variables of the API

| Variable                       | Default (development)                                  | Purpose                                                    |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| `PORT`                         | `3000` (image: `8080`)                                 | HTTP and WebSocket port                                    |
| `DB_DIR`                       | `data/db` in the working directory (image: `/data/db`) | SQLite database `claude-remote-manager.sqlite`             |
| `PROJECTS_DIR`                 | `~/.local/share/claude-remote-manager/projects`        | Base of the default session working directory              |
| `SESSION_CWD`                  | `$PROJECTS_DIR/scratch`                                | Working directory of new sessions (created if missing)     |
| `SESSION_ADDITIONAL_DIRS`      | none                                                   | Colon-separated extra directories new sessions may access  |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `60`                                                   | Close Claude Code processes idle this long; `0` keeps them |
| `CLAUDE_CODE_EXECUTABLE`       | the binary bundled with the Agent SDK                  | Other Claude Code executable for the sessions              |
| `CLAUDE_CONFIG_DIR`            | `~/.claude` (image: `/data/claude`)                    | Read by Claude Code: login, settings, transcripts          |
| `WEB_ROOT`                     | `public` next to the bundle (image: `/app/public`)     | Built web app served by the API                            |
| `ALLOWED_HOSTS`                | none (loopback names are always allowed)               | Comma-separated host names the server answers to           |
| `ALLOWED_ORIGINS`              | `http://localhost:4200` outside production             | Comma-separated origins besides the server's own           |

### Request guard

The API has no login of its own and drives an agent with tools, so every HTTP request and
WebSocket upgrade passes a guard (`apps/api/src/app/security`):

- The `Host` header must be a loopback name (`localhost`, `127.0.0.1`, `::1`, `*.localhost`),
  a name in `ALLOWED_HOSTS` or the host of an `ALLOWED_ORIGINS` entry. This stops DNS
  rebinding. **In production set `ALLOWED_HOSTS` to the public host name**, e.g.
  `ALLOWED_HOSTS=crm.example.com`, or every request through the tunnel is refused with 403.
- A request with an `Origin` header must come from the same origin (`Origin` host equals
  `Host`) or from `ALLOWED_ORIGINS`; `Origin: null` is refused. Browsers send `Origin` on
  every WebSocket upgrade and on cross-site or non-GET requests.
- Without `Origin`, POSTs and WebSocket upgrades are refused only if the browser marks them
  as cross-site (`Sec-Fetch-Site`). Non-browser clients such as curl or the container health
  check work unchanged.
- Request bodies must be `application/json` (415 otherwise), so HTML forms on other sites
  cannot post to the API.

Routes that need another protection (e.g. a signed webhook) are exempted in
`REQUEST_GUARD_EXEMPT_ROUTES`.

## Sessions

```
browser ──REST /api/sessions──▶ SessionsController ─┐
   ▲                                                ▼
   └──WebSocket /api/ws──── SessionsGateway ◀── SessionsService ──▶ AgentRunner (Agent SDK query)
                                                    │                     │
                                     SQLite (sessions, usage)    Claude Code process per session
```

- `POST /api/sessions` creates a session in the configured working directory and starts a
  Claude Code process through the Agent SDK in streaming-input mode. The process stays alive
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
- Status: `running` (Claude works on a turn), `waiting` (waits for the user, whether or not
  a process is alive), `finished` (ended with "End session", `POST /api/sessions/:id/end` or
  the `session.end` frame) and `failed` (the process could not start or ended with an error
  during a turn). A message to a finished or failed session resumes it. A turn cut off by a
  server stop is recorded with a notice and the session waits again; on shutdown the server
  waits up to 5 seconds for the Claude Code processes to exit.
- Usage: every result message's tokens (input, output, cache write, cache read) and the SDK's
  theoretical cost in USD are stored per request and model in `usage_records`; the session
  shows the totals. Context window usage and the account's rate limits are captured after
  each turn (`GET /api/limits`).
- Permissions: sessions run in permission mode `default`. Until approval dialogs exist, every
  tool use that needs approval is denied and shown as such in the chat.
- Settings: sessions get Claude Code's own system prompt and the user, project and local
  settings, including `CLAUDE.md` files of the working directory and the user's; the managed
  policy `/etc/claude-code/CLAUDE.md` is always loaded.

REST: `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`,
`POST /api/sessions/:id/messages`, `POST /api/sessions/:id/interrupt`,
`POST /api/sessions/:id/end`, `GET /api/limits`,
`GET /api/health`. WebSocket: `/api/ws` with the versioned protocol in
`libs/shared-types/src/lib/session-events.ts`.

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
binary that ships with the Agent SDK, so the CLI and the sessions always use the same version. The app runs as the non-root user
`claude` (UID/GID 1000, changeable with the build args `USER_UID`/`USER_GID`) on port 8080.

### Volumes

All state lives in volumes under `/data`, plus the Nix store, which has to stay at `/nix`:

| Path              | Contents                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `/data/repos`     | Main checkouts of cloned repositories: `<owner>/<repo>`                                         |
| `/data/worktrees` | Session worktrees: `<owner>/<repo>/<session>` on branch `claude/<session>`                      |
| `/data/projects`  | New projects without an existing repository: `<name>`                                           |
| `/data/claude`    | Claude Code configuration dir (`CLAUDE_CONFIG_DIR`): login, settings, transcripts               |
| `/data/git`       | `ssh/` (linked as `~/.ssh`: key, `known_hosts`), `gitconfig` (`GIT_CONFIG_GLOBAL`), credentials |
| `/data/db`        | SQLite database                                                                                 |
| `/nix`            | Nix store and Nix's user cache, so tools are downloaded only once                               |

The paths are also available to the app as `DATA_DIR`, `REPOS_DIR`, `WORKTREES_DIR`,
`PROJECTS_DIR`, `DB_DIR`, `CLAUDE_CONFIG_DIR` and `GIT_CONFIG_GLOBAL`.

`docker-compose.yml` uses named volumes. Bind mounts work as well; the directories must then be
owned by UID 1000 (or the configured `USER_UID`). The entrypoint creates missing directories.

**Nix store volume.** A volume over `/nix` hides the Nix installation in the image. Docker fills
an empty _named_ volume with the image content on first use, so that case needs nothing else.
For everything else the image contains a compressed copy of its `/nix` in `/opt/nix-seed`, and
the entrypoint checks on each start whether the image's Nix profile exists in `/nix`:

- empty `/nix` (e.g. a new bind mount): the copy is unpacked;
- `/nix` from an older image (profile missing): the image's store paths are added and registered
  in the existing Nix database, everything already in the store is kept.

### Logging in to Claude

Claude Code uses the Claude account (subscription), not an API key. Log in once inside the
running container; the credentials are stored in `/data/claude/.credentials.json` and survive
restarts and re-creations of the container.

```sh
docker compose exec claude-remote-manager claude
```

On first start Claude Code asks you to log in (otherwise type `/login`). Choose the Claude
account, open the shown URL in your browser and paste the code back into the terminal. Check the
result with `docker compose exec claude-remote-manager claude auth status`.

Alternative for setups without an interactive terminal: run `claude setup-token` (anywhere, also
in the container) to create a long-lived OAuth token and pass it to the container as the
environment variable `CLAUDE_CODE_OAUTH_TOKEN`. The token is a secret; do not put it into the
image or the compose file in plain text.

### Global CLAUDE.md

`docker/CLAUDE.md` holds the rules for all sessions in the container (directory layout,
worktrees, Nix, git). The image installs it as the managed policy file
`/etc/claude-code/CLAUDE.md`, which Claude Code loads in addition to the user's
`/data/claude/CLAUDE.md`. That way it is not hidden by the Claude volume and image updates take
effect immediately, while personal additions can still go into the volume.
