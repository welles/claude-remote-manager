#!/usr/bin/env bash
# Smoke test of a built image: starts it with throwaway volumes, waits for
# the health check and checks the separation of the API and the sessions.
#   docker/smoke-test.sh <image>
set -euo pipefail

image="${1:?usage: docker/smoke-test.sh <image>}"
name="crm-smoke-$$"
cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$name" -e AUTH_MODE=none "$image" >/dev/null

healthy=""
for _ in $(seq 1 60); do
  if docker exec "$name" curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [ -z "$healthy" ]; then
  echo "The container did not become healthy" >&2
  docker logs "$name" 2>&1 | tail -n 50 >&2 || true
  exit 1
fi

fail() {
  echo "FAIL: $1" >&2
  docker logs "$name" 2>&1 | tail -n 30 >&2 || true
  exit 1
}

post_token() { # <user> [token]
  docker exec -u "$1" "$name" curl -s -X POST \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${2:-crm_unknown}" \
    -d '{}' http://127.0.0.1:8080/api/session-tokens/git
}

# The session user: refused by the management API, let through to the token
# helper's route (where an unknown process token is refused).
docker exec -u claude "$name" curl -s http://127.0.0.1:8080/api/sessions \
  | grep -q session_process_refused \
  || fail 'the session user reached the management API'
post_token claude | grep -q 'Unknown or expired session token' \
  || fail 'the session user did not reach the token route'
# Everyone else: refused at the token route.
post_token crm | grep -q session_process_only \
  || fail 'the API user reached the token route'
# The session user cannot read the API's data.
if docker exec -u claude "$name" ls /data/db >/dev/null 2>&1; then
  fail 'the session user can read /data/db'
fi
# The tools sessions use.
docker exec -u claude "$name" gh --version >/dev/null 2>&1 || fail 'gh does not run'
docker exec -u claude "$name" nix --version >/dev/null \
  || fail 'nix does not run'
docker exec -u claude "$name" claude --version >/dev/null \
  || fail 'claude does not run'

echo "Smoke test of $image passed"
