# Rules for all sessions in this container

You run inside the Claude Remote Manager container. Every session works on one or more
repositories, each in its own git worktree, or in a new project. Other sessions may work
on the same repositories at the same time, in their own worktrees. These rules apply to
all sessions.

## Directory layout

| Path                                       | Contents                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `/data/repos/<owner>/<repo>`               | Shared clone of a repository (bare, no files). Never work or run git here.  |
| `/data/worktrees/<owner>/<repo>/<session>` | Worktree of a repository for one session, on branch `claude/<session>`      |
| `/data/projects/<name>`                    | New project without an existing repository; the session works directly here |
| `/data/claude`                             | Claude Code configuration, login and transcripts. Do not edit.              |
| `/data/git`                                | SSH key (`ssh/`), git config and credentials. Do not edit.                  |
| `/data/db`                                 | Database of the session manager. Do not touch.                              |
| `/nix`                                     | Nix store, shared cache for all sessions                                    |

## Worktrees

- Your working directory is the worktree of the session's main repository (or the new
  project). Further repositories of the session are worktrees of their own that were
  added as additional directories. All of them are on the session branch
  `claude/<session>`, created from the base branch the user chose (usually the default
  branch). Work only in these directories, never in the shared clones under
  `/data/repos` and never in worktrees of other sessions.
- Stay on the session branch. Do not check out, switch to, reset, rebase or delete other
  branches, in particular the `claude/*` branches of other sessions. To get changes of
  the base branch, `git fetch` and merge or rebase `origin/<base>` into your branch.
- Do not create, move, lock or remove worktrees, and do not run `git worktree prune`;
  the session manager handles that.

## What worktrees of one repository share

All worktrees of a repository use the same shared clone. Besides the objects, they share:

- all branches, tags and remote-tracking branches (`origin/*`);
- the stash: `git stash` in one worktree shows up, and can be popped, in every other
  one. Do not use `git stash`; commit work in progress on your branch instead;
- the git configuration (`git config` without `--worktree` writes the shared file) and
  the hooks. Do not change them: no `git config`, `git remote add/set-url`, installing
  hooks or setting `core.hooksPath` (e.g. `husky install`). Use `git -c name=value` for a
  single command. Ask the user if a build really needs such a change.

Therefore also: do not create, move or delete tags, and do not run `git gc --prune=now`,
`git prune`, `git reflog expire` or `git update-ref` on refs other than your branch.

Per worktree, and safe to use, are `HEAD`, the index and the files of your worktree.

## Tools

- Repositories with a `flake.nix`: always build, test and run tools inside its dev shell,
  e.g. `nix develop -c npm test`, or enter it with `nix develop` first.
- Missing tools: get them from Nix instead of installing them globally, e.g.
  `nix shell nixpkgs#dotnet-sdk -c dotnet build`. There is no root access and no `apt`.
- The image itself only provides a small base: git, Node.js/npm, curl, ssh and Nix.
- A repository may have a setup script (e.g. `npm ci`) that already ran in your worktree
  before your first message; its output is shown to the user.

## Git

- Commit only on the session branch. You may commit and push on your own, but only after
  the user approved it in the current session.
- Never force-push, rewrite published history or push to branches other than the session
  branch unless the user explicitly asks for it.
