# Working on Claude Remote Manager

Instructions for Claude sessions working on this repository. What the app is and how it works:
`README.md`; the specification (German): `docs/specification.md`; what the Claude review checks:
`.github/review-instructions.md`.

## The owner

- Reply in German; code, comments, commits and docs are English (the specification German).
- Ask in chat when something is unclear or missing instead of guessing, even if it stalls the
  work. Product decisions are the owner's; record them in the specification as
  "Umsetzung (entschieden)".

## Workflow

- Every change goes through a pull request on a branch; never commit to `main` directly.
- Compact English conventional commits (`feat:`, `fix(api):`, `docs:`, …).
- After each implementation package, a **separate Opus agent reviews it** (read-only, given
  the commit and what to look at, not your conclusions); implement its recommendations, then
  open the PR.
- The central Claude reviewer runs on every PR (`.github/workflows/claude-review.yml`); address
  its findings, reply on the thread with what changed, resolve it.
- Merge (squash) only when the owner said so and review and all checks are green.
- Before a PR: `npx nx run-many -t lint test build -p api web shared-types`; for changes to
  `nix/` also `nix flake check` and the VM tests (`nix build .#checks.x86_64-linux.vm-install
  .#checks.x86_64-linux.vm-upgrade`, needs KVM). Changed npm dependencies need
  `nix/update-npm-deps-hash.sh`.

## Rules

- Database migrations under `apps/api/src/app/db/migrations` are published: never change one,
  only add.
- Never read, print or copy the GitHub App's private key or any secret (sops, age keys, tofu
  state); never put the owner's name or email into files.
- Real GitHub actions (pushes, PRs, issues) for testing only on `welles/crm-playground`; do not
  change the GitHub App's settings.
- Real Claude requests for testing sparingly, with the smallest model, a minimal environment
  (`env -i`) and never this repository as working directory.
- Never use or delete the default data locations (`data/db`, `~/.local/share/claude-remote-manager`)
  or the running service's `/var/lib/claude-remote-manager`; local runs use temporary directories.
- No host-wide Docker or Nix cleanup; no deploying, `nh` or SSH to the owner's machines.

## Deployment

- Runs as a NixOS service on the owner's devbox, as the owner's user without sandbox (sessions
  are Claude Code of that user with `~/.claude`), behind a Cloudflare Tunnel and Access. The host
  configuration is the private repository `welles/nixos-config`
  (`modules/claude-remote-manager.nix`, `hosts/nico-devbox-nixos`, Cloudflare in `cloudflare/`
  with OpenTofu).
- After a green CI run on `main`, the job `update-nixos-config` dispatches
  `update-claude-remote-manager.yml` in nixos-config, which updates the flake input; the owner
  deploys with the next switch. Breaking changes to `nix/module.nix` need a matching nixos-config
  PR merged together.

## State (2026-11-19)

- Specification steps 1–11 are done and deployed; since then: `auto` and `bypassPermissions`
  modes with an Autofix lock, sessions without sandbox, `/` autocomplete for slash commands,
  the file browser.
- Deferred by the owner: **Rewind** (undo a turn with its file changes).
- Open: previews of dev servers are built but off on the devbox (no preview domain yet; a
  wildcard two labels below the app's domain needs Cloudflare's Advanced Certificate, or a
  separate domain); `/` autocomplete in the new-session form; whether a failed setup script of
  an added repository should notify.
