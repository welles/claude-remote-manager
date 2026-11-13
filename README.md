# Claude Remote Manager

A self-hosted web frontend for managing Claude Code sessions on a home server: sessions that
work on several repositories at once, each in its own clone of the repository, with live chat, diffs and
cleanup. Everything runs in one Docker container. See [docs/specification.md](docs/specification.md)
(German) for the full specification.

Current state: repositories are chosen from GitHub through the app's GitHub App (or registered
by clone URL), local projects by name; sessions run through the Claude Agent SDK in their own
clones of one or more repositories (or in a scratch directory) and stream to a minimal chat
view; session branches are pushed and pull requests created by button, or by Claude after the
user's approval; usage is recorded per request. Approval dialogs, the full chat view and the
cleanup of sessions follow.

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

Set the git author name and email on the Settings page first (commits in session clones are
made with them). Add a repository on the Repositories page (from GitHub if the GitHub App is
configured, see [GitHub](#github); or any clone URL git can use with the credentials of your
shell, or a local path), then start a session on it with a short prompt (choose Haiku to
keep it cheap), watch the answer stream in, send a follow-up, restart the API and send another
message: the session is resumed. Mirrors, session clones and scratch directories live in
`~/.local/share/claude-remote-manager/workspace` by default, outside this repository; the
database lives in `data/db` of this repository (gitignored).

For GitHub, start it with `GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_FILE=/path/to/key.pem`. In
development the session clones also see your global git configuration (e.g. commit signing);
in the container that is `/data/git/gitconfig`.

Start the API from a normal shell. Started from inside a Claude Code session it inherits that
session's `CLAUDE_*`/`ANTHROPIC_*` variables and passes them on to the sessions it runs.

### Environment variables of the API

| Variable                            | Default (development)                                                                            | Purpose                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `PORT`                              | `3000` (image: `8080`)                                                                           | HTTP and WebSocket port                                         |
| `DB_DIR`                            | `data/db` in the working directory (image: `/data/db`)                                           | SQLite database `claude-remote-manager.sqlite`                  |
| `WORKSPACE_DIR`                     | `~/.local/share/claude-remote-manager/workspace`                                                 | `repos/`, `sessions/`, `scratch/` on one filesystem             |
| `SETUP_SCRIPT_TIMEOUT_MINUTES`      | `15`                                                                                             | Setup scripts are stopped after this long                       |
| `SESSION_IDLE_TIMEOUT_MINUTES`      | `60`                                                                                             | Close Claude Code processes idle this long; `0` keeps them      |
| `CLAUDE_CODE_EXECUTABLE`            | the binary bundled with the Agent SDK                                                            | Other Claude Code executable for the sessions                   |
| `CLAUDE_CONFIG_DIR`                 | `~/.claude` (image: `/data/claude`)                                                              | Read by Claude Code: login, settings, transcripts               |
| `MEMORY_DIR`                        | `$CLAUDE_CONFIG_DIR/repository-memory`, without it `~/.local/share/claude-remote-manager/memory` | Claude Code's auto-memory per repository                        |
| `GITHUB_APP_ID`                     | none (GitHub not configured)                                                                     | App ID of the GitHub App (plain configuration)                  |
| `GITHUB_APP_PRIVATE_KEY_FILE`       | none                                                                                             | File with the app's private key (PEM), e.g. a Docker secret     |
| `CRM_SECRET_GITHUB_APP_PRIVATE_KEY` | none                                                                                             | The private key itself, instead of the file                     |
| `INTERNAL_API_URL`                  | `http://127.0.0.1:$PORT`                                                                         | How the git credential helper in session clones reaches the API |
| `WEB_ROOT`                          | `public` next to the bundle (image: `/app/public`)                                               | Built web app served by the API                                 |
| `ALLOWED_HOSTS`                     | none (loopback names are always allowed)                                                         | Comma-separated host names the server answers to                |
| `ALLOWED_ORIGINS`                   | `http://localhost:4200` outside production                                                       | Comma-separated origins besides the server's own                |

Secrets of the app are never passed to the processes it starts (Claude Code, setup scripts,
its own git commands): every variable named `CRM_SECRET_*` is removed, plus a registry of fixed
names in `apps/api/src/app/common/child-environment.ts` (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN`, which only Claude Code gets). New
secrets must use the `CRM_SECRET_` prefix, so a forgotten registration still keeps them out.
The GitHub App's private key is read once at startup and kept only in the API's memory (see
[GitHub](#github) for what that does and does not protect).

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
  is alive; with `pendingMessage` set after a failed setup script, see below), `finished`
  (ended with "End session", `POST /api/sessions/:id/end` or the `session.end` frame) and
  `failed` (a clone could not be created, or the process could not start or ended with an
  error during a turn). A message to a finished or failed session resumes it, unless its
  directories are gone (failed preparation, removed clones). A turn
  cut off by a server stop is recorded with a notice and the session waits again; on shutdown
  the server waits up to 5 seconds for the Claude Code processes to exit.
- Usage: every result message's tokens (input, output, cache write, cache read) and the SDK's
  theoretical cost in USD are stored per request and model in `usage_records`; the session
  shows the totals. Context window usage and the account's rate limits are captured after
  each turn (`GET /api/limits`).
- Permissions: sessions run in permission mode `default`. Every tool use that needs approval
  goes through a `ToolApprover`; until the approval dialogs exist it denies everything and the
  chat shows the denial. Approved uses are recorded (see [Push and pull requests](#push-and-pull-requests)).
- Integrations: each Claude Code process gets a session token and the API URL for the git
  credential helper, the tool `create_pull_request` (in-process MCP server `crm`) when the
  session has a GitHub repository, a permission rule that makes `git push` always ask, and the
  auto-memory directory of its main repository.
- Settings: sessions get Claude Code's own system prompt and the user, project and local
  settings, including `CLAUDE.md` files of the working directory and the user's; the managed
  policy `/etc/claude-code/CLAUDE.md` is always loaded.

REST: `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`,
`POST /api/sessions/:id/messages`, `POST /api/sessions/:id/interrupt`,
`POST /api/sessions/:id/end`, `POST /api/sessions/:id/pending-message/send`,
`POST /api/sessions/:id/setup/rerun`, `POST /api/sessions/:id/repositories/:repositoryId/push`,
`POST /api/sessions/:id/repositories/:repositoryId/pull-requests`,
`POST /api/sessions/:id/pull-requests/refresh`, `GET /api/repositories`,
`GET /api/repositories/:id`, `POST /api/repositories`, `PATCH /api/repositories/:id`,
`POST /api/repositories/:id/fetch`, `POST /api/repositories/:id/github`,
`GET /api/repositories/:id/branches`, `GET /api/github/status`, `GET /api/github/repositories`,
`GET /api/settings`, `PUT /api/settings`, `POST /api/git/credentials` (credential helper only),
`GET /api/limits`, `GET /api/health`. WebSocket: `/api/ws` with the versioned protocol in
`libs/shared-types/src/lib/session-events.ts`.

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
  `branch`, `base_branch`, `base_commit` — the commit the branch started at, for diffs of the
  whole session — and `setup_status`), `scratch`, or `directory` (sessions from before session
  clones). `state` is `pending`, `ready`, `failed` or `removed`. This table is the only source
  of a session's directories (the former `sessions.cwd` was migrated into it).
  `pushed_commit`/`pushed_at`: what was last pushed of the session branch (by button, or seen
  after an approved push by Claude).
- `pull_requests`: per session clone (session and repository) the pull requests created by
  button or by Claude: number, URL, title, state (`open`, `closed`, `merged`), draft, head and
  base branch, creator (`user`/`claude`), opened/closed/merged times and when the state was
  last read from GitHub (open ones at most once a minute when the session is opened). The
  PR automation builds on this table.
- `app_settings`: settings edited in the UI (key, JSON value): the commit identity.

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
(`GitService.removeSessionClone`) and fast-forwarding a local project exist for the cleanup
step; there is no UI for them yet.

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

Issues, Checks, Commit statuses and Actions (read) are for later steps (GitHub references in
the prompt, PR automation); the webhook is not used yet. Install the app on your account and
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

| Operation                              | Token                                                                |
| -------------------------------------- | -------------------------------------------------------------------- |
| listing an installation's repositories | `metadata: read`, whole installation                                 |
| clone and fetch of a mirror            | `contents: read`                                                     |
| push by button                         | `contents: write` (+ `workflows: write` if workflow files changed)   |
| create / read a pull request           | `pull_requests: write` + `contents: read` / `pull_requests: read`    |
| credential helper, normally            | `contents: read`                                                     |
| credential helper, approved push       | `contents: write` (+ `workflows`), fresh, revoked when the push ends |
| create a repository                    | `administration: write`, fresh, revoked afterwards                   |

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

Approval: every tool use that needs approval goes through `canUseTool` and the
`ToolApprover`. Today it denies everything (the approval dialogs come in the next step), so
these paths only work by button; tests use a fake approver. Approvals are what unlock them, not
Claude Code's own decision: `git push` has an `ask` permission rule in every session (it wins
over allow rules, e.g. from a repository's `.claude/settings.json`), the tool has the MCP
permission policy `always_ask`, and if anything still skipped `canUseTool` (a permission mode,
an allow rule) no grant is recorded, so the helper stays read-only and the tool refuses.

What this boundary cannot guarantee:

- An approved command does whatever it does. A push grant is recognized from the command
  text (`git … push`) and holds for the whole session (all its GitHub repositories, every
  process) while that command runs; a command like `git push && git credential fill` would
  show a write token to Claude. Commands that push in other ways (scripts, aliases) are not
  recognized and get a read-only token, which fails safely.
- Read-only tokens are available to every process of the session at any time (for
  `git fetch`), e.g. by running the helper or `git credential fill`, which itself is a Bash
  command that needs approval.
- All sessions and the API run as one user in the container. A process of a session can read
  files and `/proc/<pid>/environ` of other processes of that user: other sessions' tokens,
  and the private key file (or the API's environment, if the key is passed as variable).
  Claude Code asks before reading outside the session's directories, so only an approved tool
  use can get there; a hard boundary needs separate users or a separate token service.

### Local projects on GitHub

"Put on GitHub" (`POST /api/repositories/:id/github`) creates a repository and pushes the
project's branches and tags there, or attaches an existing empty repository the app can
access. Organizations: `POST /orgs/{org}/repos` with an installation token works with the
Administration permission. Personal account: GitHub's documentation lists
`POST /user/repos` for installation tokens too, but this is not verified; if GitHub refuses,
the error says to create an empty repository on GitHub and attach it instead.

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
| `/data/workspace` | `repos/` (mirrors), `sessions/<slug>/<owner>/<repo>` (session clones), `scratch/<slug>`         |
| `/data/claude`    | Claude Code configuration dir (`CLAUDE_CONFIG_DIR`): login, settings, transcripts               |
| `/data/git`       | `ssh/` (linked as `~/.ssh`: key, `known_hosts`), `gitconfig` (`GIT_CONFIG_GLOBAL`), credentials |
| `/data/db`        | SQLite database                                                                                 |
| `/nix`            | Nix store and Nix's user cache, so tools are downloaded only once                               |

The paths are also available to the app as `DATA_DIR`, `WORKSPACE_DIR`, `DB_DIR`,
`CLAUDE_CONFIG_DIR` and `GIT_CONFIG_GLOBAL`. The workspace must be one volume (one filesystem),
so that session clones can hardlink the mirrors' objects.

`docker-compose.yml` uses named volumes. Bind mounts work as well; the directories must then be
owned by UID 1000 (or the configured `USER_UID`). The entrypoint creates missing directories.

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

Compose bind-mounts the file with its host owner and mode; it must be readable by the
container user (UID 1000), e.g. owned by it with mode `0400`. Or without Compose:
`docker run -v /path/github-app.pem:/run/secrets/github-app-key:ro -e GITHUB_APP_ID=…
-e GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-key …`. Never put the key into the image
or the compose file itself.

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
session clones, Nix, git). The image installs it as the managed policy file
`/etc/claude-code/CLAUDE.md`, which Claude Code loads in addition to the user's
`/data/claude/CLAUDE.md`. That way it is not hidden by the Claude volume and image updates take
effect immediately, while personal additions can still go into the volume.
