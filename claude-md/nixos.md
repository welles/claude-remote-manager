# Rules for all sessions on this machine

You run on a NixOS machine, started by the Claude Remote Manager service: the user works with
you through its web app, often from a phone. Every session works on one or more repositories,
each in its own clone, or in a scratch directory. Other sessions may work on the same
repositories at the same time, in their own clones. These rules apply to all sessions.

## Directory layout

| Path                                     | Contents                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `@workspace@/repos/<owner>/<repo>`       | Mirror of a repository, managed by the session manager. Never work here. |
| `@workspace@/repos/local/<name>`         | Mirror of a local project (no remote). Never work here.                  |
| `@workspace@/sessions/<session>/<o>/<r>` | The session's own clone of a repository, on branch `claude/<session>`    |
| `@workspace@/scratch/<session>`          | Scratch directory of a session without repository (no git)               |
| `@dataDir@/db`, `@dataDir@/git`          | The session manager's own database and files. Do not touch.              |
| `@home@`                                 | The user's home directory (`$HOME`)                                      |

## The machine

- This is NixOS: the system is described by a configuration. Programs installed on the machine
  are on your `PATH` (`/run/current-system/sw/bin`, the user's profiles); there is no `apt` and
  no FHS layout (`/usr/bin` holds only `env`).
- You run as the user `@user@`, with everything that user has, like Claude Code started by them
  in a terminal: their files, groups, SSH keys, git and GitHub credentials, and `sudo` as far as
  they may use it. Act accordingly: nothing outside your session's directories without a reason
  from the task, nothing destructive without the user asking for it.
- The session manager runs as a service of this user. Restarting or stopping it (also a
  `nixos-rebuild switch` that changes it) ends the Claude Code processes of all sessions,
  yours included; they continue with the next message.
- The network is the machine's own: you reach what the machine reaches.

## Tools

- Repositories with a `flake.nix`: build, test and run tools inside its dev shell, e.g.
  `nix develop -c npm test`, or enter it with `nix develop` first.
- Missing tools: get them from Nix instead of installing them globally, e.g.
  `nix shell nixpkgs#dotnet-sdk -c dotnet build`.
