#!/bin/sh
# Prepares the data volumes, then runs the given command (the API by default).
#
# The container starts as root only for this script. With
# PROCESS_ISOLATION=separate-users (the image default) it gives the volumes
# their owners and then starts the API as the user "crm" with exactly the
# capabilities it needs to start session processes as the session user
# (see apps/api/src/app/common/process-isolation.ts):
#
#   crm      API, database, mirrors, GitHub App key, /data/git
#   claude   Claude Code, setup scripts, session clones, /data/claude, /nix
#
# Started as another user (docker run --user ...), the script only prepares
# what that user can and runs the command directly; the API then needs
# PROCESS_ISOLATION=single-user.
set -eu

API_USER=crm
SESSION_USER="${SESSION_USER:-claude}"
API_CAPS=cap_chown,cap_dac_override,cap_kill,cap_setgid,cap_setuid

fail() {
  echo "error: $*" >&2
  exit 1
}

# Runs a command as the session user, without capabilities.
as_session() {
  setpriv --reuid="$SESSION_USER" --regid="$SESSION_USER" --init-groups -- "$@"
}

# --- Nix store ---------------------------------------------------------------
# /nix is a volume. Docker populates an empty *named* volume from the image on
# first use, so it normally already contains the image's Nix. Two cases need
# help, both handled with the seed in /opt/nix-seed:
#  - an empty bind mount (Docker does not copy image content into those):
#    unpack the complete /nix of the image;
#  - a volume created by an older image: the image's Nix profile is missing,
#    so add its store paths and register them in the existing Nix database.
seed_nix() {
  seed=/opt/nix-seed
  profile="$(cat "$seed/profile")"
  if [ ! -e "$profile" ]; then
    if [ ! -w /nix ]; then
      echo "error: /nix is not writable for $(id -un) (uid $(id -u)); fix the owner of the volume or bind mount." >&2
      exit 1
    fi
    if [ ! -e /nix/var/nix/db/db.sqlite ]; then
      echo "Seeding empty /nix from the image ..."
      zstd -dc "$seed/nix.tar.zst" | tar -C /nix -xf -
    else
      echo "Adding the image's Nix to the existing /nix store ..."
      zstd -dc "$seed/nix.tar.zst" | tar -C /nix -xf - --skip-old-files ./store
      nix-store --load-db < "$seed/db.dump"
    fi
  fi
  mkdir -p /nix/var/nix/user-cache
}

if [ "$(id -u)" != 0 ]; then
  if [ "${PROCESS_ISOLATION:-}" = separate-users ]; then
    fail "PROCESS_ISOLATION=separate-users needs the container to start as root (the entrypoint drops it); set PROCESS_ISOLATION=single-user to run as $(id -un)."
  fi
  seed_nix
  mkdir -p "$WORKSPACE_DIR/repos" "$WORKSPACE_DIR/sessions" "$WORKSPACE_DIR/scratch" \
    "$DB_DIR" "$CLAUDE_CONFIG_DIR" /data/git/ssh
  chmod 0700 "$CLAUDE_CONFIG_DIR" /data/git /data/git/ssh 2>/dev/null || true
  touch "$GIT_CONFIG_GLOBAL"
  exec "$@"
fi

if [ "${PROCESS_ISOLATION:-}" != separate-users ]; then
  fail "running as root is only supported with PROCESS_ISOLATION=separate-users"
fi
id "$API_USER" >/dev/null 2>&1 || fail "user $API_USER does not exist"
id "$SESSION_USER" >/dev/null 2>&1 || fail "session user $SESSION_USER does not exist"
SESSION_UID="$(id -u "$SESSION_USER")"

# --- Owners of the volumes ---------------------------------------------------
# Only changed where the top directory has the wrong owner (first start, or a
# volume from an image before the users were separated).
own() { # owner dir...
  owner="$1"
  shift
  for dir in "$@"; do
    mkdir -p "$dir"
    if [ "$(stat -c %U "$dir")" != "$owner" ]; then
      echo "Giving $dir to $owner ..."
      chown -R "$owner:$owner" "$dir"
    fi
  done
}
own "$SESSION_USER" /nix "$CLAUDE_CONFIG_DIR"
own "$API_USER" "$DB_DIR" /data/git "$WORKSPACE_DIR" "$WORKSPACE_DIR/repos" \
  "$WORKSPACE_DIR/sessions" "$WORKSPACE_DIR/scratch"
chmod 0700 "$DB_DIR" /data/git
chmod 0755 "$WORKSPACE_DIR" "$WORKSPACE_DIR/repos" "$WORKSPACE_DIR/sessions" \
  "$WORKSPACE_DIR/scratch"
chmod 0700 "$CLAUDE_CONFIG_DIR"
mkdir -p /data/git/ssh
touch "$GIT_CONFIG_GLOBAL"
chown -R "$API_USER:$API_USER" /data/git

# Session clones and scratch directories belong to the session user, except
# the object files hardlinked from the mirrors (the mirrors' own files).
for clone in "$WORKSPACE_DIR"/sessions/*/*/*; do
  [ -d "$clone" ] || continue
  if [ "$(stat -c %u "$clone")" != "$SESSION_UID" ]; then
    echo "Giving $clone to $SESSION_USER ..."
    find "$clone" \( -path '*/.git/objects/*' -type f -links +1 \) -prune \
      -o -exec chown -h "$SESSION_USER:$SESSION_USER" {} +
  fi
done
for scratch in "$WORKSPACE_DIR"/scratch/*; do
  [ -d "$scratch" ] || continue
  if [ "$(stat -c %u "$scratch")" != "$SESSION_UID" ]; then
    chown -R "$SESSION_USER:$SESSION_USER" "$scratch"
  fi
done

# Nix belongs to the session user, who installs tools with it.
as_session env HOME="/home/$SESSION_USER" PATH="$PATH" sh -eu -c '
  seed=/opt/nix-seed
  profile="$(cat "$seed/profile")"
  if [ ! -e "$profile" ]; then
    if [ ! -e /nix/var/nix/db/db.sqlite ]; then
      echo "Seeding empty /nix from the image ..."
      zstd -dc "$seed/nix.tar.zst" | tar -C /nix -xf -
    else
      echo "Adding the image'"'"'s Nix to the existing /nix store ..."
      zstd -dc "$seed/nix.tar.zst" | tar -C /nix -xf - --skip-old-files ./store
      nix-store --load-db < "$seed/db.dump"
    fi
  fi
  mkdir -p /nix/var/nix/user-cache
'

# --- Secret files ------------------------------------------------------------
# The GitHub App key, the webhook secret, the ntfy token and the VAPID
# private key must be readable by the API and not by sessions.
check_secret_file() { # variable-name
  file="$(eval "printf '%s' \"\${$1:-}\"")"
  [ -n "$file" ] || return 0
  if as_session test -r "$file"; then
    fail "the session user $SESSION_USER can read $file ($1); give the file to UID $(id -u "$API_USER") with mode 0400 (or 0600) on the host"
  fi
  if ! setpriv --reuid="$API_USER" --regid="$API_USER" --init-groups -- test -r "$file"; then
    fail "the API user $API_USER (UID $(id -u "$API_USER")) cannot read $file ($1)"
  fi
}
check_secret_file GITHUB_APP_PRIVATE_KEY_FILE
check_secret_file GITHUB_WEBHOOK_SECRET_FILE
check_secret_file NTFY_TOKEN_FILE
check_secret_file VAPID_PRIVATE_KEY_FILE

# --- Start the API -----------------------------------------------------------
# Session processes keep the image's PATH, which starts with the session
# user's Nix profile. The API's own PATH holds only root-owned directories:
# it resolves the commands it runs (setpriv with its capabilities, git on the
# mirrors) there, so nothing the session user installs can run as the API.
export SESSION_PATH="${SESSION_PATH:-$PATH}"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# As crm with the capabilities in its ambient set: they survive the exec into
# node, and the API drops them for every process it starts.
export HOME="/home/$API_USER" USER="$API_USER" LOGNAME="$API_USER"
exec capsh --inh="$API_CAPS" --keep=1 --user="$API_USER" --addamb="$API_CAPS" \
  -- -c 'exec "$@"' crm-api "$@"
