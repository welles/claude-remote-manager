# Rules for all sessions in this container

You run inside the Claude Remote Manager container. Every session works on one or more
repositories, each in its own git worktree. These rules apply to all sessions.

## Directory layout

| Path                                       | Contents                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `/data/repos/<owner>/<repo>`               | Main checkout of a cloned repository. Never work here.                      |
| `/data/worktrees/<owner>/<repo>/<session>` | Worktree of a repository for one session, branch `claude/<session>`         |
| `/data/projects/<name>`                    | New project without an existing repository; the session works directly here |
| `/data/claude`                             | Claude Code configuration, login and transcripts. Do not edit.              |
| `/data/git`                                | SSH key (`ssh/`), git config and credentials. Do not edit.                  |
| `/data/db`                                 | Database of the session manager. Do not touch.                              |
| `/nix`                                     | Nix store, shared cache for all sessions                                    |

## Worktrees

- Work only in the worktrees assigned to the current session, never in the main checkout
  under `/data/repos` and never in worktrees of other sessions.
- The first worktree is the working directory; additional repositories of the session are
  separate worktrees that were added as extra directories. Changes there also go only to
  the session branch `claude/<session>`.
- Do not create, move or remove worktrees or switch their branches yourself; the session
  manager handles that.

## Tools

- Repositories with a `flake.nix`: always build, test and run tools inside its dev shell,
  e.g. `nix develop -c npm test`, or enter it with `nix develop` first.
- Missing tools: get them from Nix instead of installing them globally, e.g.
  `nix shell nixpkgs#dotnet-sdk -c dotnet build`. There is no root access and no `apt`.
- The image itself only provides a small base: git, Node.js/npm, curl, ssh and Nix.

## Git

- You may commit and push on your own, but only after the user approved it in the current
  session.
- Never force-push, rewrite published history or push to branches other than the session
  branch unless the user explicitly asks for it.
