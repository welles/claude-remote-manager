# Rules for all sessions on this machine

You run on a NixOS machine, started by the Claude Remote Manager service. Every session works
on one or more repositories, each in its own clone, or in a scratch directory. Other sessions
may work on the same repositories at the same time, in their own clones. These rules apply to
all sessions.

## Directory layout

| Path                                     | Contents                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `@workspace@/repos/<owner>/<repo>`       | Mirror of a repository, managed by the session manager. Never work here. |
| `@workspace@/repos/local/<name>`         | Mirror of a local project (no remote). Never work here.                  |
| `@workspace@/sessions/<session>/<o>/<r>` | The session's own clone of a repository, on branch `claude/<session>`    |
| `@workspace@/scratch/<session>`          | Scratch directory of a session without repository (no git)               |
| `@claudeConfig@`                         | Claude Code configuration, login and transcripts. Do not edit.           |
| `@dataDir@/db`, `@dataDir@/git`          | The session manager's own; not accessible to sessions.                   |
| `@home@`                                 | Your home directory (`$HOME`)                                            |

## The machine

- This is NixOS: the system is described by a configuration you cannot change. Programs
  installed on the machine are on your `PATH` (`/run/current-system/sw/bin`, your user's
  profiles); there is no `apt` and no FHS layout (`/usr/bin` holds only `env`).
- You run as the user `@sessionUser@`, not as the session manager: its API, its database and
  keys are out of reach. You have no root access: `sudo` and `su` do not work (session
  processes cannot gain privileges).
- The file system is read-only for you except your session's directories, your home
  directory@writablePaths@. `/tmp` is private to the session manager's service and shared by
  all sessions.
- The network is the machine's own: you reach what the machine reaches.

## Tools

- Repositories with a `flake.nix`: always build, test and run tools inside its dev shell,
  e.g. `nix develop -c npm test`, or enter it with `nix develop` first.
- Missing tools: get them from Nix instead of installing them globally, e.g.
  `nix shell nixpkgs#dotnet-sdk -c dotnet build`. Nix is the machine's: builds run in its
  Nix daemon and land in the shared, read-only `/nix/store`. You are not a trusted Nix user,
  so options that need trust (other substituters, `--option sandbox false`, importing
  unsigned paths) are refused.
