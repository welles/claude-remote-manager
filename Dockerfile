# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build: web app and API through Nx.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS build
WORKDIR /src
ENV NX_DAEMON=false \
    NX_NO_CLOUD=true \
    NX_SKIP_NX_CACHE=true

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx nx run-many -t build -p web api

# Production dependencies of the API, from the lockfile Nx generates for it.
WORKDIR /src/dist/apps/api
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Runtime: Node.js, git, ssh, Claude Code and single-user Nix, as a non-root user.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim

ARG NIX_VERSION=2.35.6
ARG CLAUDE_CODE_VERSION=2.1.322
ARG USER_NAME=claude
ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client tini xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*

# The base image ships a "node" user with UID/GID 1000; rename it so the
# container user has a meaningful name and home directory.
RUN groupmod -n "${USER_NAME}" -g "${USER_GID}" node \
    && usermod -l "${USER_NAME}" -u "${USER_UID}" -g "${USER_GID}" -d "/home/${USER_NAME}" -m node

# Claude Code CLI (used by the Agent SDK and for logging in). Auto-updates are
# disabled because the global npm directory is not writable for the app user;
# bump CLAUDE_CODE_VERSION instead.
RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# Nix, single-user, owned by the app user, with flakes enabled.
COPY docker/nix.conf /etc/nix/nix.conf
RUN mkdir -m 0755 /nix && chown "${USER_UID}:${USER_GID}" /nix

USER ${USER_NAME}
ENV USER=${USER_NAME} \
    HOME=/home/${USER_NAME}
WORKDIR /home/${USER_NAME}
RUN curl -fsSL "https://releases.nixos.org/nix/nix-${NIX_VERSION}/install" -o /tmp/nix-install \
    && sh /tmp/nix-install --no-daemon --no-channel-add --no-modify-profile \
    && rm /tmp/nix-install \
    && . "${HOME}/.nix-profile/etc/profile.d/nix.sh" \
    && nix --version \
    # Keep Nix's user cache (flake inputs, eval cache) in the /nix volume too.
    && mkdir -p /nix/var/nix/user-cache "${HOME}/.cache" \
    && ln -s /nix/var/nix/user-cache "${HOME}/.cache/nix" \
    # Seed for an empty or outdated /nix volume, see docker/entrypoint.sh.
    && profile="$(readlink -f "${HOME}/.nix-profile")" \
    && mkdir -p /tmp/nix-seed \
    && echo "${profile}" > /tmp/nix-seed/profile \
    && nix-store --dump-db $(nix-store -qR "${profile}") > /tmp/nix-seed/db.dump \
    && tar -C /nix -cf - . | zstd -q -T0 -19 -o /tmp/nix-seed/nix.tar.zst

USER root
RUN mv /tmp/nix-seed /opt/nix-seed && chown -R root:root /opt/nix-seed

# Global instructions for all Claude sessions, outside the Claude volume.
COPY docker/CLAUDE.md /etc/claude-code/CLAUDE.md
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/app-entrypoint

# Data layout, see README.md. The directories are created here so that named
# volumes start with the right owner.
ENV DATA_DIR=/data \
    REPOS_DIR=/data/repos \
    WORKTREES_DIR=/data/worktrees \
    PROJECTS_DIR=/data/projects \
    DB_DIR=/data/db \
    CLAUDE_CONFIG_DIR=/data/claude \
    GIT_CONFIG_GLOBAL=/data/git/gitconfig \
    DISABLE_AUTOUPDATER=1 \
    PATH=/home/${USER_NAME}/.nix-profile/bin:${PATH} \
    NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
RUN mkdir -p /data/repos /data/worktrees /data/projects /data/db /data/claude /data/git/ssh \
    && chmod 0700 /data/claude /data/git /data/git/ssh \
    && ln -s /data/git/ssh "/home/${USER_NAME}/.ssh" \
    && chown -R "${USER_UID}:${USER_GID}" /data "/home/${USER_NAME}/.ssh"

WORKDIR /app
COPY --from=build /src/dist/apps/api ./
COPY --from=build /src/dist/apps/web/browser ./public

ENV NODE_ENV=production \
    PORT=8080 \
    WEB_ROOT=/app/public

# Version and commit the image was built from, reported by /api/health.
# Last, so a new commit only changes this layer.
ARG VERSION=0.0.0
ARG COMMIT=""
ARG COMMIT_TIME=""
ENV APP_VERSION=${VERSION} \
    APP_COMMIT=${COMMIT} \
    APP_COMMIT_TIME=${COMMIT_TIME}

USER ${USER_NAME}
VOLUME ["/data/repos", "/data/worktrees", "/data/projects", "/data/claude", "/data/git", "/data/db", "/nix"]
EXPOSE 8080
# The start period covers seeding an empty /nix on the first start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
    CMD curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["tini", "--", "app-entrypoint"]
CMD ["node", "/app/main.js"]
