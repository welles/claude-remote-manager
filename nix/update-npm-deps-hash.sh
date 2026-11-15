#!/usr/bin/env bash
# Updates nix/npm-deps-hash.json after package-lock.json changed: builds the
# npm dependencies with a placeholder hash and takes the hash Nix reports.
# Run from anywhere inside the repository; needs Nix with flakes.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
file=nix/npm-deps-hash.json
system="${1:-x86_64-linux}"
fake="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
old="$(jq -r --arg s "$system" '.[$s]' "$file")"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
jq --indent 2 --arg s "$system" --arg h "$fake" '.[$s] = $h' "$file" > "$tmp" && cp "$tmp" "$file"
if out="$(nix build --no-link ".#packages.$system.default.npmDeps" 2>&1)"; then
  # Cannot happen with the placeholder; keep the old hash.
  jq --indent 2 --arg s "$system" --arg h "$old" '.[$s] = $h' "$file" > "$tmp" && cp "$tmp" "$file"
  echo "unexpected: the build succeeded with the placeholder hash" >&2
  exit 1
fi
new="$(printf '%s\n' "$out" | sed -n 's/^ *got: *\(sha256-[A-Za-z0-9+/=]*\).*/\1/p' | tail -n 1)"
if [ -z "$new" ]; then
  jq --indent 2 --arg s "$system" --arg h "$old" '.[$s] = $h' "$file" > "$tmp" && cp "$tmp" "$file"
  printf '%s\n' "$out" >&2
  echo "error: no hash in the output above; $file left unchanged" >&2
  exit 1
fi
jq --indent 2 --arg s "$system" --arg h "$new" '.[$s] = $h' "$file" > "$tmp" && cp "$tmp" "$file"
if [ "$new" = "$old" ]; then
  echo "npm dependency hash for $system unchanged: $new"
else
  echo "npm dependency hash for $system: $old -> $new"
fi
