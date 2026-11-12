# Claude Remote Manager

A self-hosted web frontend for managing Claude Code sessions on a home server: sessions that
work on several repositories at once, each in its own git worktree, with live chat, diffs and
cleanup. Everything runs in one Docker container. See [docs/specification.md](docs/specification.md)
(German) for the full specification.

Current state: project skeleton. The API serves the web app and a health endpoint; sessions,
worktrees and the GitHub integration follow.

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
```

The scripts wrap Nx; use `npx nx <target> <project>` for a single project, e.g. `npx nx test web`.

The Angular dev server proxies `/api` to the API (`apps/web/proxy.conf.json`). In production the
API serves the built web app itself from `WEB_ROOT`.

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
Claude Code CLI and Nix (single-user, flakes enabled). The app runs as the non-root user
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
