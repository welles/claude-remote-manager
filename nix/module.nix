# NixOS module: Claude Remote Manager as a systemd service running as a
# user of the machine (PROCESS_ISOLATION=single-user). Sessions can do what
# that user can do in a terminal: its Claude Code configuration (~/.claude),
# git and GitHub credentials, sudo, devices, the whole file system. See
# README.md, "Running as a NixOS service".
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    optional
    optionalAttrs
    concatStringsSep
    ;

  cfg = config.services.claude-remote-manager;
  userDef = config.users.users.${cfg.user} or null;
  home = if userDef == null then "/home/${cfg.user}" else userDef.home;

  workspaceDir = "${cfg.dataDir}/workspace";
  dbDir = "${cfg.dataDir}/db";
  gitDir = "${cfg.dataDir}/git";

  # Tools every session can rely on, after the user's own profiles and the
  # system profile, plus the consumer's packages. Node.js is the one the app
  # runs on, so sessions and the app's helper scripts agree on it.
  sessionEnv = pkgs.buildEnv {
    name = "claude-remote-manager-session-env";
    paths =
      (with pkgs; [
        bashInteractive
        coreutils
        findutils
        diffutils
        gnugrep
        gnused
        gawk
        gnutar
        gzip
        xz
        zstd
        which
        procps
        less
        git
        openssh
        curl
        ripgrep
      ])
      ++ [
        config.nix.package
        cfg.package.nodejs or pkgs.nodejs_24
      ]
      ++ cfg.packages;
    pathsToLink = [
      "/bin"
      "/share"
    ];
  };

  # The user's PATH as a NixOS login shell has it: the wrappers (sudo, ping,
  # ...), then environment.profiles (the user's own Nix profiles, its
  # per-user profile, the default and the system profile), followed by the
  # tools above.
  expandProfile =
    p:
    builtins.replaceStrings
      [
        "$HOME"
        "$USER"
        "\${XDG_STATE_HOME}"
      ]
      [
        home
        cfg.user
        "${home}/.local/state"
      ]
      p;
  sessionPath = concatStringsSep ":" (
    [ "/run/wrappers/bin" ]
    ++ map (p: "${expandProfile p}/bin") config.environment.profiles
    ++ [ "${sessionEnv}/bin" ]
  );

  # Secret files, handed to the service as systemd credentials: systemd reads
  # them as root (so sops-nix may keep them root-only) and provides copies
  # for the service user under $CREDENTIALS_DIRECTORY.
  secrets = lib.filterAttrs (_: v: v.file != null) {
    github-app-key = {
      file = cfg.github.privateKeyFile;
      variable = "GITHUB_APP_PRIVATE_KEY_FILE";
    };
    github-webhook-secret = {
      file = cfg.github.webhookSecretFile;
      variable = "GITHUB_WEBHOOK_SECRET_FILE";
    };
    ntfy-token = {
      file = cfg.ntfy.tokenFile;
      variable = "NTFY_TOKEN_FILE";
    };
    vapid-private-key = {
      file = cfg.vapid.privateKeyFile;
      variable = "VAPID_PRIVATE_KEY_FILE";
    };
  };

  secretPaths = lib.mapAttrsToList (_: v: v.file) secrets ++ cfg.environmentFiles;

  # Appended to Claude Code's system prompt in every session
  # (SESSION_INSTRUCTIONS_FILE): this machine, then the rules shared with
  # the image, then the consumer's own text. Not a machine-wide
  # /etc/claude-code/CLAUDE.md, which Claude Code in the user's terminal
  # would load as well.
  instructions = pkgs.runCommand "claude-remote-manager-instructions" { } ''
    mkdir $out
    substitute ${../claude-md/nixos.md} nixos.md \
      --replace-fail @workspace@ ${lib.escapeShellArg workspaceDir} \
      --replace-fail @dataDir@ ${lib.escapeShellArg cfg.dataDir} \
      --replace-fail @home@ ${lib.escapeShellArg home} \
      --replace-fail @user@ ${lib.escapeShellArg cfg.user}
    { cat nixos.md; echo; cat ${../claude-md/core.md}; } > $out/CLAUDE.md
    ${lib.optionalString (cfg.extraInstructions != "") ''
      { echo; cat ${pkgs.writeText "extra-instructions.md" cfg.extraInstructions}; } >> $out/CLAUDE.md
    ''}
  '';

  # Earlier versions of this module ran the API and the sessions as two
  # other users. Their files in the data directory are given to the user
  # once; a stamp says to whom the directory was given last. This runs as
  # root on a tree the user can change meanwhile:
  # - the stamp lives in a directory only root writes (a stamp in the data
  #   directory could be a symlink to any file);
  # - the data directory must not be a symlink and its parents must be
  #   root's and writable by root only (or sticky), so it cannot be
  #   pointed elsewhere;
  # - hard links to other users' files cannot be planted in it
  #   (`fs.protected_hardlinks`, checked);
  # - `chown -R` walks with directory file descriptors and never follows
  #   symlinks (`--no-dereference`, `-P`), so swapping a directory for a
  #   symlink during the walk does not lead it out of the tree.
  takeOverDataDir = pkgs.writeShellScript "claude-remote-manager-take-over-data-dir" ''
    set -eu
    dir=${lib.escapeShellArg cfg.dataDir}
    stamps=/var/lib/claude-remote-manager-owner
    stamp="$stamps/${builtins.hashString "sha256" cfg.dataDir}"
    ${pkgs.coreutils}/bin/mkdir -p -m 0700 "$stamps"
    ${pkgs.coreutils}/bin/chown root:root "$stamps"
    ${pkgs.coreutils}/bin/chmod 0700 "$stamps"
    if [ "$(${pkgs.coreutils}/bin/cat "$stamp" 2>/dev/null || true)" = ${lib.escapeShellArg cfg.user} ]; then
      exit 0
    fi
    if [ -L "$dir" ]; then
      echo "$dir is a symlink; refusing to give it to ${cfg.user}" >&2
      exit 1
    fi
    if [ "$(${pkgs.coreutils}/bin/cat /proc/sys/fs/protected_hardlinks)" != 1 ]; then
      echo "fs.protected_hardlinks is off; refusing to give $dir to ${cfg.user}" >&2
      exit 1
    fi
    parent=$(${pkgs.coreutils}/bin/dirname "$dir")
    while :; do
      if [ -L "$parent" ] || [ "$(${pkgs.coreutils}/bin/stat -c %u "$parent")" != 0 ]; then
        echo "$parent is not root's directory; refusing to give $dir to ${cfg.user}" >&2
        exit 1
      fi
      # Others may write to it only with the sticky bit (as in /tmp).
      mode=$(${pkgs.coreutils}/bin/stat -c %a "$parent")
      if [ $(( 0$mode & 01000 )) = 0 ] && [ $(( 0$mode & 022 )) != 0 ]; then
        echo "$parent is writable by others; refusing to give $dir to ${cfg.user}" >&2
        exit 1
      fi
      [ "$parent" = / ] && break
      parent=$(${pkgs.coreutils}/bin/dirname "$parent")
    done
    echo "Giving $dir to ${cfg.user} ..."
    ${pkgs.coreutils}/bin/chown -R --no-dereference -P ${lib.escapeShellArg "${cfg.user}:${cfg.group}"} "$dir"
    echo ${lib.escapeShellArg cfg.user} > "$stamp"
  '';

  list = concatStringsSep ",";

  locale = {
    LANG = config.i18n.defaultLocale;
    LOCALE_ARCHIVE = "${config.i18n.glibcLocales}/lib/locale/locale-archive";
  };

  serviceEnvironment = {
    NODE_ENV = "production";
    PORT = toString cfg.port;
    LISTEN_ADDRESS = cfg.listenAddress;
    PROCESS_ISOLATION = "single-user";
    SESSION_PATH = sessionPath;
    DATA_DIR = cfg.dataDir;
    DB_DIR = dbDir;
    WORKSPACE_DIR = workspaceDir;
    MEMORY_DIR = "${cfg.dataDir}/memory";
    # The configuration directory of earlier versions: transcripts of old
    # sessions are copied from there into ~/.claude once.
    LEGACY_CLAUDE_CONFIG_DIR = "${cfg.dataDir}/claude";
    # The API's own git commands on mirrors; sessions use ~/.gitconfig.
    API_GIT_CONFIG_GLOBAL = "${gitDir}/gitconfig";
    SESSION_INSTRUCTIONS_FILE = "${instructions}/CLAUDE.md";
    # Claude Code of the package is the version the Agent SDK expects.
    DISABLE_AUTOUPDATER = "1";
    SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
    NIX_SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
    AUTH_MODE = cfg.auth.mode;
  }
  // locale
  // optionalAttrs (config.time.timeZone != null) { TZ = config.time.timeZone; }
  // optionalAttrs (cfg.auth.mode == "cloudflare-access") {
    CF_ACCESS_TEAM_DOMAIN = cfg.auth.teamDomain;
    CF_ACCESS_AUD = list cfg.auth.audiences;
  }
  // optionalAttrs (cfg.auth.allowedEmails != [ ]) {
    CF_ACCESS_ALLOWED_EMAILS = list cfg.auth.allowedEmails;
  }
  // optionalAttrs (cfg.allowedHosts != [ ]) { ALLOWED_HOSTS = list cfg.allowedHosts; }
  // optionalAttrs (cfg.allowedOrigins != [ ]) { ALLOWED_ORIGINS = list cfg.allowedOrigins; }
  // optionalAttrs (cfg.publicUrl != null) { PUBLIC_URL = cfg.publicUrl; }
  // optionalAttrs (cfg.preview.url != null) { PREVIEW_URL = cfg.preview.url; }
  // optionalAttrs (cfg.preview.accessAudiences != [ ]) {
    PREVIEW_ACCESS_AUD = list cfg.preview.accessAudiences;
  }
  // optionalAttrs (cfg.ntfy.url != null) {
    NTFY_URL = cfg.ntfy.url;
    NTFY_TOPIC = cfg.ntfy.topic;
  }
  // optionalAttrs (cfg.github.appId != null) { GITHUB_APP_ID = toString cfg.github.appId; }
  // optionalAttrs (cfg.vapid.publicKey != null) { VAPID_PUBLIC_KEY = cfg.vapid.publicKey; }
  // optionalAttrs (cfg.vapid.subject != null) { VAPID_SUBJECT = cfg.vapid.subject; }
  // lib.mapAttrs' (name: v: lib.nameValuePair v.variable "%d/${name}") secrets
  // cfg.environment;

  secretFileType = types.nullOr (
    types.str
    // {
      description = "absolute path of a file outside the Nix store";
    }
  );
  isSecretPath = p: p == null || (lib.hasPrefix "/" p && !lib.hasPrefix builtins.storeDir p);

  opt =
    path:
    [
      "services"
      "claude-remote-manager"
    ]
    ++ path;
  removed =
    path: why:
    lib.mkRemovedOptionModule (opt path) ''
      Sessions now run as services.claude-remote-manager.user, with that user's own
      ~/.claude, credentials and rights, and without a sandbox. ${why}
    '';
in
{
  imports = [
    # The session user is the service's user now.
    (lib.mkRenamedOptionModule (opt [
      "sessionUser"
      "name"
    ]) (opt [ "user" ]))
    (lib.mkRenamedOptionModule (opt [
      "sessionUser"
      "packages"
    ]) (opt [ "packages" ]))
    (removed [ "sessionUser" "create" ] "Set `user` to an existing user and remove this option.")
    (removed [ "sessionUser" "group" ] "The group is the user's primary group (`group`).")
    (removed [ "sessionUser" "home" ] "HOME is the user's home directory.")
    (removed [ "sessionUser" "extraGroups" ] "Give the user its groups where it is defined.")
    (removed [ "sessionUser" "writablePaths" ] "Sessions can write what the user can write.")
    (removed [ "hiddenPaths" ] "Nothing is hidden from sessions any more.")
    (removed [
      "claudeConfigDir"
    ] "Sessions use the user's ~/.claude; old transcripts are copied there at startup from <dataDir>/claude only. If you had set claudeConfigDir elsewhere, move that directory to <dataDir>/claude before the first start (the start step gives it to the user).")
  ];

  options.services.claude-remote-manager = {
    enable = mkEnableOption "Claude Remote Manager, a web frontend for Claude Code sessions";

    package = mkOption {
      type = types.package;
      description = "The claude-remote-manager package (the flake's `packages.<system>.default`).";
    };

    user = mkOption {
      type = types.str;
      example = "alice";
      description = ''
        User the service runs as, and with it every session (Claude Code,
        setup scripts, git, dev servers): an existing user of the
        configuration, usually the owner's login user. Sessions use its
        `~/.claude` (login, settings, skills, plugins, MCP servers, memory),
        its git configuration, `gh` login and SSH keys, its groups and its
        `sudo`, like Claude Code started by that user in a terminal. Never
        root.
      '';
    };

    group = mkOption {
      type = types.str;
      default = if userDef == null then "users" else userDef.group;
      defaultText = lib.literalExpression "config.users.users.\${user}.group";
      description = "Group of the service and of the data directory.";
    };

    packages = mkOption {
      type = types.listOf types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.jq pkgs.python3 ]";
      description = ''
        Packages on the PATH of sessions, after the user's profiles and the
        system profile. A base of git, a shell, coreutils, Nix, Node.js,
        curl, ssh and ripgrep is always there.
      '';
    };

    listenAddress = mkOption {
      type = types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = ''
        Address the HTTP server listens on. The default keeps it on loopback,
        for a tunnel or reverse proxy on the same machine.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "HTTP and WebSocket port.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Open the port in the firewall. Only with an authenticating proxy in
        front or `auth.mode = "cloudflare-access"`: whoever controls the
        sessions acts as `user` on this machine.
      '';
    };

    dataDir = mkOption {
      type = types.str;
      default = "/var/lib/claude-remote-manager";
      example = "/persist/var/lib/claude-remote-manager";
      description = ''
        The app's state, owned by `user`: `db/` (database, the API's files,
        generated VAPID keys), `workspace/` (mirrors, session clones,
        scratch directories; one file system), `memory/` (Claude Code's
        memory per repository), `git/` (the API's git configuration). On a
        machine with impermanence point it below the persistent volume.
      '';
    };

    auth = {
      mode = mkOption {
        type = types.enum [
          "cloudflare-access"
          "none"
        ];
        description = ''
          `cloudflare-access`: the API verifies the Cloudflare Access token
          of every request. `none`: no authentication (loopback-only setups
          for testing).
        '';
      };
      teamDomain = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "example.cloudflareaccess.com";
        description = "Cloudflare Access team domain.";
      };
      audiences = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Application Audience (AUD) tags of the app's Access application.";
      };
      allowedEmails = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "owner@example.com" ];
        description = "Optional allowlist of email addresses (empty: everyone Access lets in).";
      };
    };

    allowedHosts = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "crm.example.com" ];
      description = ''
        Host names the server answers to besides loopback names; the public
        host name belongs here.
      '';
    };

    allowedOrigins = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Origins besides the server's own that may call the API.";
    };

    publicUrl = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "https://crm.example.com";
      description = "Public URL of the app (links in ntfy notifications).";
    };

    preview = {
      url = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "https://preview.example.com";
        description = "Base of the preview host names of dev servers; null turns previews off.";
      };
      accessAudiences = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = ''
          Audience tag(s) of the previews' own Access application (required
          with Cloudflare Access and previews; never one of `auth.audiences`).
        '';
      };
    };

    ntfy = {
      url = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "https://ntfy.example.com";
        description = "ntfy server; null turns ntfy off.";
      };
      topic = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "ntfy topic.";
      };
      tokenFile = mkOption {
        type = secretFileType;
        default = null;
        example = "/run/secrets/crm/ntfy-token";
        description = "File with the ntfy access token.";
      };
    };

    github = {
      appId = mkOption {
        type = types.nullOr (types.either types.ints.positive types.str);
        default = null;
        description = "App ID of the GitHub App; null runs without GitHub.";
      };
      privateKeyFile = mkOption {
        type = secretFileType;
        default = null;
        example = "/run/secrets/crm/github-app-key";
        description = "File with the GitHub App's private key (PEM).";
      };
      webhookSecretFile = mkOption {
        type = secretFileType;
        default = null;
        example = "/run/secrets/crm/github-webhook-secret";
        description = "File with the GitHub App's webhook secret (PR automation).";
      };
    };

    vapid = {
      privateKeyFile = mkOption {
        type = secretFileType;
        default = null;
        description = ''
          File with an own VAPID private key for Web Push; without it keys are
          generated into the database directory.
        '';
      };
      publicKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "VAPID public key (checked against the private key).";
      };
      subject = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "mailto:owner@example.com";
        description = "VAPID contact (`mailto:` or `https:`).";
      };
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        SESSION_STALL_MINUTES = "20";
        SESSION_IDLE_TIMEOUT_MINUTES = "120";
        SSH_AUTH_SOCK = "/home/alice/.ssh/agent.sock";
      };
      description = ''
        Further variables of the service and its sessions (see the README's
        table), e.g. `SESSION_STALL_MINUTES`, or an `SSH_AUTH_SOCK` the
        sessions should use. Never secrets: these end up in the Nix store.
      '';
    };

    environmentFiles = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "/run/secrets/crm/env" ];
      description = ''
        Files with `NAME=value` lines added to the service's environment
        (read by systemd as root), for secrets that only exist as variables,
        e.g. `CRM_SECRET_*`.
      '';
    };

    extraInstructions = mkOption {
      type = types.lines;
      default = "";
      example = ''
        ## Home network

        - The printer is at printer.example.com.
      '';
      description = ''
        Markdown appended to the instructions every session gets (on top of
        the user's own CLAUDE.md files), after the module's description of
        the machine.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = userDef != null;
        message = "services.claude-remote-manager: user = \"${cfg.user}\" needs users.users.${cfg.user} defined in the configuration (sessions run as that user).";
      }
      {
        assertion = cfg.user != "root";
        message = "services.claude-remote-manager: the service must not run as root; set user to the owner's login user.";
      }
      {
        assertion =
          cfg.auth.mode != "cloudflare-access" || (cfg.auth.teamDomain != null && cfg.auth.audiences != [ ]);
        message = "services.claude-remote-manager: auth.mode = \"cloudflare-access\" needs auth.teamDomain and auth.audiences.";
      }
      {
        assertion =
          cfg.preview.url == null
          || cfg.auth.mode != "cloudflare-access"
          || cfg.preview.accessAudiences != [ ];
        message = "services.claude-remote-manager: preview.url with Cloudflare Access needs preview.accessAudiences (the previews' own Access application).";
      }
      {
        assertion = lib.all (aud: !lib.elem aud cfg.auth.audiences) cfg.preview.accessAudiences;
        message = "services.claude-remote-manager: preview.accessAudiences must differ from auth.audiences.";
      }
      {
        assertion = (cfg.ntfy.url == null) == (cfg.ntfy.topic == null);
        message = "services.claude-remote-manager: ntfy needs both ntfy.url and ntfy.topic.";
      }
      {
        assertion = cfg.ntfy.url == null || cfg.ntfy.tokenFile != null || cfg.environmentFiles != [ ];
        message = "services.claude-remote-manager: ntfy needs ntfy.tokenFile.";
      }
      {
        assertion = cfg.github.privateKeyFile == null || cfg.github.appId != null;
        message = "services.claude-remote-manager: github.privateKeyFile needs github.appId.";
      }
      {
        assertion =
          cfg.github.appId == null || cfg.github.privateKeyFile != null || cfg.environmentFiles != [ ];
        message = "services.claude-remote-manager: github.appId needs github.privateKeyFile.";
      }
      {
        assertion =
          cfg.vapid.publicKey == null || cfg.vapid.privateKeyFile != null || cfg.environmentFiles != [ ];
        message = "services.claude-remote-manager: vapid.publicKey needs vapid.privateKeyFile.";
      }
      {
        assertion = lib.all isSecretPath secretPaths;
        message = "services.claude-remote-manager: secret files (github.privateKeyFile, github.webhookSecretFile, ntfy.tokenFile, vapid.privateKeyFile, environmentFiles) must be absolute paths outside the Nix store, e.g. sops-nix's /run/secrets/...";
      }
      {
        assertion = lib.hasPrefix "/" cfg.dataDir;
        message = "services.claude-remote-manager: dataDir must be an absolute path.";
      }
    ];

    warnings =
      optional
        (
          cfg.auth.mode == "none"
          && (
            cfg.openFirewall
            || !lib.elem cfg.listenAddress [
              "127.0.0.1"
              "::1"
              "localhost"
            ]
          )
        )
        "services.claude-remote-manager: auth.mode = \"none\" on a non-loopback address: everyone who reaches the port acts as ${cfg.user} on this machine.";

    # Directories and their owners; `d` adjusts mode and owner of the
    # directory itself, never recursively (the service's start takes over
    # an earlier version's files, see takeOverDataDir).
    systemd.tmpfiles.settings."10-claude-remote-manager" =
      let
        dir = mode: {
          d = {
            inherit (cfg) user group;
            inherit mode;
          };
        };
      in
      {
        ${cfg.dataDir} = dir "0700";
        ${dbDir} = dir "0700";
        ${gitDir} = dir "0700";
        "${gitDir}/gitconfig".f = {
          inherit (cfg) user group;
          mode = "0600";
        };
        ${workspaceDir} = dir "0755";
        "${workspaceDir}/repos" = dir "0755";
        "${workspaceDir}/sessions" = dir "0755";
        "${workspaceDir}/scratch" = dir "0755";
      };

    networking.firewall.allowedTCPPorts = optional cfg.openFirewall cfg.port;

    systemd.services.claude-remote-manager = {
      description = "Claude Remote Manager";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "systemd-tmpfiles-setup.service"
        "systemd-tmpfiles-resetup.service"
      ];
      # The API's own PATH: store paths only, for its git and find commands;
      # sessions get the user's PATH (SESSION_PATH).
      path = with pkgs; [
        git
        openssh
        coreutils
        findutils
        bash
      ];
      environment = serviceEnvironment;

      # No sandbox: sessions are Claude Code of the user, with sudo,
      # devices, containers, the whole file system and all processes.
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        ExecStartPre = [ "+${takeOverDataDir}" ];
        ExecStart = lib.getExe cfg.package;
        WorkingDirectory = cfg.dataDir;
        Restart = "on-failure";
        RestartSec = 5;
        # The API stops its Claude Code processes on SIGTERM (up to 5 s).
        TimeoutStopSec = 30;
        # The one-time take-over of an old data directory walks all clones.
        TimeoutStartSec = "infinity";
        LoadCredential = lib.mapAttrsToList (name: v: "${name}:${v.file}") secrets;
        EnvironmentFile = cfg.environmentFiles;
      };
    };
  };
}
