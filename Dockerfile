# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build: web app and API through Nx.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS build
WORKDIR /src
ENV NX_DAEMON=false \
    NX_NO_CLOUD=true \
    NX_SKIP_NX_CACHE=true

# better-sqlite3 ships prebuilt binaries. Depending on npm's install-script
# policy, npm still runs its implicit node-gyp step, which then compiles
# nothing but needs Python and a toolchain. Build stage only; the runtime
# image gets no build tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx nx run-many -t build -p web api

# Production dependencies of the API, from the lockfile Nx generates for it.
WORKDIR /src/dist/apps/api
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Runtime: Node.js, git, ssh and single-user Nix, as a non-root user. Claude
# Code comes with the Agent SDK in the API's dependencies.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim

ARG NIX_VERSION=2.35.6
# Two users (see docker/entrypoint.sh): the API runs as "crm", everything a
# session runs as "claude". The API's UID 1000 matches the usual owner of a
# mounted key file, so that the API can read it and sessions cannot.
ARG API_UID=1000
ARG API_GID=1000
ARG USER_NAME=claude
ARG USER_UID=1001
ARG USER_GID=1001

# libcap2-bin: capsh, used by the entrypoint to start the API with its
# capabilities; setpriv (util-linux) starts session processes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git libcap2-bin openssh-client tini xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*

# The base image ships a "node" user with UID/GID 1000; it becomes the API
# user, and the session user is added.
RUN groupmod -n crm -g "${API_GID}" node \
    && usermod -l crm -u "${API_UID}" -g "${API_GID}" -d /home/crm -m node \
    && groupadd -g "${USER_GID}" "${USER_NAME}" \
    && useradd -u "${USER_UID}" -g "${USER_GID}" -d "/home/${USER_NAME}" -m -s /bin/bash "${USER_NAME}"

# Nix, single-user, owned by the session user, with flakes enabled.
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

# Global instructions for all Claude sessions, outside the Claude volume: the
# container's own part and the part shared with the NixOS module.
COPY claude-md/container.md claude-md/core.md /tmp/claude-md/
RUN mkdir -p /etc/claude-code \
    && { cat /tmp/claude-md/container.md; echo; cat /tmp/claude-md/core.md; } > /etc/claude-code/CLAUDE.md \
    && rm -rf /tmp/claude-md
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/app-entrypoint

# Data layout, see README.md. The directories are created here so that named
# volumes start with the right owner.
ENV DATA_DIR=/data \
    WORKSPACE_DIR=/data/workspace \
    DB_DIR=/data/db \
    CLAUDE_CONFIG_DIR=/data/claude \
    GIT_CONFIG_GLOBAL=/data/git/gitconfig \
    DISABLE_AUTOUPDATER=1 \
    PATH=/home/${USER_NAME}/.nix-profile/bin:${PATH} \
    NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
# The workspace holds mirrors, session clones and scratch directories on
# one filesystem, so that session clones can hardlink the mirrors' objects.
RUN mkdir -p /data/workspace/repos /data/workspace/sessions /data/workspace/scratch \
        /data/db /data/claude /data/git/ssh \
    && chmod 0700 /data/claude /data/git /data/git/ssh /data/db \
    && ln -s /data/git/ssh /home/crm/.ssh \
    && chown -R "${API_UID}:${API_GID}" /data /home/crm/.ssh \
    && chown -R "${USER_UID}:${USER_GID}" /data/claude

WORKDIR /app
COPY --from=build /src/dist/apps/api ./
COPY --from=build /src/dist/apps/web/browser ./public

# The Agent SDK runs the Claude Code binary of its platform package. Link it as
# `claude` for logging in, so the CLI and the sessions always use the same
# version (updated with the SDK); DISABLE_AUTOUPDATER keeps it that way.
RUN claude="$(ls /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude | head -n 1)" \
    && test -x "${claude}" \
    && ln -s "${claude}" /usr/local/bin/claude \
    && claude --version

ENV NODE_ENV=production \
    PROCESS_ISOLATION=separate-users \
    SESSION_USER=${USER_NAME} \
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

# Starts as root: the entrypoint gives the volumes their owners and drops
# to the API user (see docker/entrypoint.sh).
USER root
VOLUME ["/data/workspace", "/data/claude", "/data/git", "/data/db", "/nix"]
EXPOSE 8080
# The start period covers seeding an empty /nix on the first start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
    CMD curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["tini", "--", "app-entrypoint"]
CMD ["node", "/app/main.js"]
