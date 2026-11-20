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
- The image itself only provides a small base: git, `gh`, Node.js/npm, curl, ssh and Nix.
- You run as the user `claude`, not as the session manager: the session manager's API, its
  database and keys are out of reach, and `sudo`/`su` do not work.

## GitHub credentials

- `git` and `gh` get short-lived tokens of the session manager's GitHub App for this
  session's repositories, nothing else; you have no SSH key or token of your own.
- `git push` to `https://github.com/...` works for this session's repositories. The token can
  write the whole repository: push only the session branch unless the user asks for more, and
  never merge pull requests or push to the default branch with it. Pushing workflow changes
  works only on the session branch.
- `gh` can read: pull requests, reviews and comments, issues, checks, Actions runs and logs.
  It cannot comment, approve, merge, resolve review threads or change settings; create pull
  requests with the tool `create_pull_request`, reply to and resolve review threads of this
  session's own pull requests with the tool `reply_to_review_thread`, merge them with the tool
  `merge_pull_request` (only when the user asked you to, or automerge is on for the pull
  request), turn on autofix, automerge or autoclose of them with the tool `set_pr_automation`
  (only when the user asked you to), and tell the user what else needs doing. Use the
  image's `gh` (a `gh` from a Nix shell gets no token); commands that need a user, such as
  `gh pr status`, do not work.
