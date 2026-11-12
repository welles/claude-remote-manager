#!/bin/sh
# Prepares the data volumes, then runs the given command (the API by default).
set -eu

# --- Nix store ---------------------------------------------------------------
# /nix is a volume. Docker populates an empty *named* volume from the image on
# first use, so it normally already contains the image's Nix. Two cases need
# help, both handled with the seed in /opt/nix-seed:
#  - an empty bind mount (Docker does not copy image content into those):
#    unpack the complete /nix of the image;
#  - a volume created by an older image: the image's Nix profile is missing,
#    so add its store paths and register them in the existing Nix database.
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

# --- Data directories --------------------------------------------------------
# Bind mounts may start empty; create the expected layout.
mkdir -p "$REPOS_DIR" "$WORKTREES_DIR" "$PROJECTS_DIR" "$DB_DIR" "$CLAUDE_CONFIG_DIR" /data/git/ssh
chmod 0700 "$CLAUDE_CONFIG_DIR" /data/git /data/git/ssh 2>/dev/null || true
touch "$GIT_CONFIG_GLOBAL"

exec "$@"
