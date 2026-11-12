# Claude Remote Manager

A self-hosted web frontend for managing Claude Code sessions on a home server: sessions that
work on several repositories at once, each in its own git worktree, with live chat, diffs and
cleanup. Everything runs in one Docker container. See [docs/specification.md](docs/specification.md)
(German) for the full specification.

Current state: repositories are registered by clone URL; sessions run through the Claude
Agent SDK in worktrees of one or more repositories (or in a new project) and stream to a
minimal chat view; usage is recorded per request. The GitHub integration, approval dialogs,
the full chat view and worktree cleanup follow.

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

Add a repository on the Repositories page (any clone URL git can use with the credentials of
your shell, or a local path), then start a session on it with a short prompt (choose Haiku to
keep it cheap), watch the answer stream in, send a follow-up, restart the API and send another
message: the session is resumed. Clones, worktrees and new projects live in
`~/.local/share/claude-remote-manager/{repos,worktrees,projects}` by default, outside this
repository; the database lives in `data/db` of the workspace (gitignored).

Start the API from a normal shell. Started from inside a Claude Code session it inherits that
session's `CLAUDE_*`/`ANTHROPIC_*` variables and passes them on to the sessions it runs.

### Environment variables of the API

| Variable                       | Default (development)                                  | Purpose                                                    |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| `PORT`                         | `3000` (image: `8080`)                                 | HTTP and WebSocket port                                    |
| `DB_DIR`                       | `data/db` in the working directory (image: `/data/db`) | SQLite database `claude-remote-manager.sqlite`             |
| `REPOS_DIR`                    | `~/.local/share/claude-remote-manager/repos`           | Shared clones: `<owner>/<repo>`                            |
| `WORKTREES_DIR`                | `~/.local/share/claude-remote-manager/worktrees`       | Session worktrees: `<owner>/<repo>/<session-slug>`         |
| `PROJECTS_DIR`                 | `~/.local/share/claude-remote-manager/projects`        | New projects without repository: `<name>`                  |
| `SETUP_SCRIPT_TIMEOUT_MINUTES` | `15`                                                   | Setup scripts are stopped after this long                  |
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

- `POST /api/sessions` creates a session in status `preparing` and returns it. Its
  worktrees (or new project) are created and the setup scripts run (see
  [Repositories and worktrees](#repositories-and-worktrees)); then a Claude Code process
  starts through the Agent SDK in streaming-input mode with the prompt. The main repository's
  worktree is the working directory, the other worktrees are additional directories. The
  process stays alive
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
- Status: `preparing` (worktrees and setup scripts; messages are refused until it is done),
  `running` (Claude works on a turn), `waiting` (waits for the user, whether or not a process
  is alive), `finished` (ended with "End session", `POST /api/sessions/:id/end` or the
  `session.end` frame) and `failed` (a worktree could not be created, or the process could
  not start or ended with an error during a turn). A message to a finished or failed session
  resumes it, unless its worktrees are gone (failed preparation, removed worktrees). A turn
  cut off by a server stop is recorded with a notice and the session waits again; on shutdown
  the server waits up to 5 seconds for the Claude Code processes to exit.
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
`POST /api/sessions/:id/end`, `GET /api/repositories`, `GET /api/repositories/:id`,
`POST /api/repositories`, `PATCH /api/repositories/:id`, `POST /api/repositories/:id/fetch`,
`GET /api/repositories/:id/branches`, `GET /api/limits`, `GET /api/health`. WebSocket: `/api/ws` with the versioned protocol in
`libs/shared-types/src/lib/session-events.ts`.

## Repositories and worktrees

```
REPOS_DIR/acme/app                      shared clone (bare): objects, refs, config, hooks
WORKTREES_DIR/acme/app/fix-login-k3x9q2   session A, branch claude/fix-login-k3x9q2
WORKTREES_DIR/acme/app/add-export-7pd2mz  session B, branch claude/add-export-7pd2mz
WORKTREES_DIR/acme/lib/add-export-7pd2mz  session B's second repository, same branch name
PROJECTS_DIR/new-tool                     session C: new project (git init), works on main
```

### Data model

- `repositories`: owner, name, clone URL, default branch (as last fetched), path of the shared
  clone, setup script, clone/fetch times and last error; `github_repository_id` and
  `github_installation_id` are reserved for the GitHub integration.
- `projects`: new projects without repository (name, path; `repository_id` for a repository
  created for it later).
- `sessions`: as before plus the `slug` and the `pending_message` (the prompt while the
  session is prepared).
- `session_directories`: the session's directories in order; position 0 is the working
  directory, the others are additional directories. A row with `repository_id` is a
  worktree: path, `branch`, `base_branch`, `base_commit` (the commit the branch started at,
  for diffs of the whole session), `state` (`pending`, `ready`, `failed`, `removed`) and
  `setup_status`. A row with `project_id` is the new project; rows with neither are plain
  directories of sessions from before worktrees. This table is the only source of a
  session's directories (the former `sessions.cwd` was migrated into it).

### How a session gets its worktrees

1. `POST /api/sessions` with `repositories: [{ repositoryId, baseBranch? }, …]` (the first is
   the main repository) and/or `newProject: { name }`. The request is validated and a slug is
   chosen: readable part from the title or prompt (`a-z0-9-`, at most 40 characters) plus 6
   random characters, unique among sessions, worktree directories and branches.
2. Per repository, in parallel: the shared clone is created on first use, otherwise fetched;
   the worktree is created on the new branch `claude/<slug>` from the fetched base branch
   (default branch unless chosen). Events `prepare.progress` report each step.
3. If any worktree cannot be created (clone/fetch error, unknown base branch, …), the
   session's other worktrees and branches and the new project are removed again, the session
   is `failed` with an error naming the repository. A preparation cut off by a server stop is
   rolled back the same way on the next start.
4. The setup scripts run one after another in their worktrees (`bash -e -o pipefail`, with
   `CRM_SESSION_ID`, `CRM_SESSION_SLUG`, `CRM_REPOSITORY`, `CRM_WORKTREE`; secrets of the app
   removed from the environment), with `SETUP_SCRIPT_TIMEOUT_MINUTES`. Output streams as
   `setup.output` events (stored, at most 256 KB per script; the end is kept in
   `setup.result`). A failing script is reported but does not stop the session.
5. The prompt goes to Claude; the status becomes `running`. Ending the session during the
   preparation stops the setup script, keeps the worktrees and does not send the prompt.

`GET /api/repositories` lists each repository with its worktrees from three sources: the
database, `git worktree list` and the directories under `WORKTREES_DIR/<owner>/<repo>`.
Worktrees without a session are marked orphaned, worktrees a session expects but that are
gone are marked missing, and directories of unregistered repositories are listed as stray.
Removing worktrees and deleting branches exist as service functions (`GitService`) for the
cleanup step; there is no UI for them yet.

Until the GitHub integration exists, cloning and fetching use whatever git credentials the
API's environment has (SSH key, credential helper), so public HTTPS URLs and local paths work
out of the box. Clone URLs are validated (https, ssh, scp-like `git@host:owner/repo` or an
absolute local path; no credentials in the URL, no other transports); git always runs with
argument arrays and `--` before user values, without prompts and without repository hooks.

### Concurrency guarantees

Several sessions may work in the same repository at the same time:

- **Own worktree and branch per session and repository.** Paths and branches derive from the
  unique slug; the database refuses the same branch of a repository twice. Git refuses to
  check out a branch in two worktrees, so a session cannot take over another's branch.
- **The shared clone is bare and nobody works in it.** It has no working tree, index or HEAD
  that a session could change. It fetches only into `refs/remotes/origin/*`, so a fetch never
  moves a session branch, never touches a checked-out branch, and works while sessions have
  uncommitted changes. Tags from the remote overwrite local tags of the same name; local-only
  tags stay.
- **Writes to a shared clone are serialized** in the API (clone, fetch, adding and removing
  worktrees, deleting branches), per clone: sessions on other repositories do not wait.
  Sessions started at the same time share one fetch. Git's own ref locks protect against
  git commands that sessions run themselves; the API retries a few times when it meets such
  a lock.
- **Worktrees are locked** (`git worktree lock`), so `git worktree prune`, which `git gc`
  runs, keeps them even while the worktrees volume is unavailable, and a plain
  `git worktree remove` refuses them.
- **No operation of one session changes another session's files, index, HEAD or branch**:
  creating, fetching and removing are tested with real repositories and parallel operations
  (`apps/api/src/app/git/git.service.spec.ts`,
  `apps/api/src/app/workspaces/session-preparation.spec.ts`).

Limits:

- What all worktrees of a repository share by design of git: branches, tags, remote-tracking
  branches, the stash, the config and the hooks. Claude is told in the global `CLAUDE.md`
  not to change them (no `git stash`, `git config`, hook installers, tags, other branches),
  but nothing enforces it; a session with shell access can still change shared state.
- The serialization is per API process; running two API instances on the same data is not
  supported.
- Joining a running fetch can miss a commit pushed after that fetch started.
- Hooks are disabled for the API's own git commands only; inside worktrees, git uses the
  repository's hooks as usual.

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
| `/data/repos`     | Shared clones of repositories (bare): `<owner>/<repo>`                                          |
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
