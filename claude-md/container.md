# Rules for all sessions in this container

You run inside the Claude Remote Manager container. Every session works on one or more
repositories, each in its own clone, or in a scratch directory. Other sessions may work on
the same repositories at the same time, in their own clones. These rules apply to all
sessions.

## Directory layout

| Path                                                | Contents                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `/data/workspace/repos/<owner>/<repo>`              | Mirror of a repository, managed by the session manager. Never work here. |
| `/data/workspace/repos/local/<name>`                | Mirror of a local project (no remote). Never work here.                  |
| `/data/workspace/sessions/<session>/<owner>/<repo>` | The session's own clone of a repository, on branch `claude/<session>`    |
| `/data/workspace/scratch/<session>`                 | Scratch directory of a session without repository (no git)               |
| `/data/claude`                                      | Claude Code configuration, login and transcripts. Do not edit.           |
| `/data/git`, `/data/db`                             | The session manager's own; not accessible to sessions.                   |
| `/nix`                                              | Nix store, shared cache for all sessions                                 |

## Tools

- Repositories with a `flake.nix`: always build, test and run tools inside its dev shell,
  e.g. `nix develop -c npm test`, or enter it with `nix develop` first.
- Missing tools: get them from Nix instead of installing them globally, e.g.
  `nix shell nixpkgs#dotnet-sdk -c dotnet build`. There is no root access and no `apt`.
- The image itself only provides a small base: git, Node.js/npm, curl, ssh and Nix.
- You run as the user `claude`, not as the session manager: the session manager's API, its
  database and keys are out of reach, and `sudo`/`su` do not work.
