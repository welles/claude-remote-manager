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
| `/data/git`                                         | SSH key (`ssh/`), git config and credentials. Do not edit.               |
| `/data/db`                                          | Database of the session manager. Do not touch.                           |
| `/nix`                                              | Nix store, shared cache for all sessions                                 |

## Your directories

- Your working directory is the clone of the session's main repository (or its scratch
  directory). Further repositories of the session are clones of their own that were added as
  additional directories. Work only in these directories, never in the mirrors under
  `/data/workspace/repos` and never in other sessions' directories.
- Each clone is a complete repository of its own: branches, tags, stash and git config are
  yours alone. `origin` is the real remote (for a local project: its mirror); `origin/*`
  shows the state when the session started, `git fetch` updates it.
- Work on the session branch `claude/<session>`, created from the base branch the user chose
  (usually the default branch). To get newer changes of the base branch, `git fetch` and
  merge or rebase `origin/<base>`.
- A repository may have a setup script (e.g. `npm ci`) that already ran in your clone
  before your first message; its output is shown to the user.

## Tools

- Repositories with a `flake.nix`: always build, test and run tools inside its dev shell,
  e.g. `nix develop -c npm test`, or enter it with `nix develop` first.
- Missing tools: get them from Nix instead of installing them globally, e.g.
  `nix shell nixpkgs#dotnet-sdk -c dotnet build`. There is no root access and no `apt`.
- The image itself only provides a small base: git, Node.js/npm, curl, ssh and Nix.

## Git

- Commit on the session branch. You may commit on your own; push only after the user
  approved it in the current session, and only the session branch unless the user explicitly
  asks for another one.
- Never force-push or rewrite published history unless the user explicitly asks for it.
