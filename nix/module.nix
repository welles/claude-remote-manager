# NixOS module: Claude Remote Manager as a hardened systemd service in
# PROCESS_ISOLATION=separate-users mode. See README.md, "Running as a NixOS
# service".
{
  config,
  lib,
  pkgs,
  utils,
  ...
}:
let
  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    optional
    optionals
    optionalAttrs
    concatStringsSep
    ;

  cfg = config.services.claude-remote-manager;
  sessionCfg = cfg.sessionUser;
  sessionUser = sessionCfg.name;
  existingUser = !sessionCfg.create;
  userDef = config.users.users.${sessionUser} or null;
  sessionGroup = if existingUser then (if userDef == null then "users" else userDef.group) else sessionCfg.group;
  sessionHome = sessionCfg.home;

  workspaceDir = "${cfg.dataDir}/workspace";
  dbDir = "${cfg.dataDir}/db";
  gitDir = "${cfg.dataDir}/git";

  # The capabilities the API needs to start processes as the session user and
  # manage the files it hands over (see apps/api/src/app/common/process-isolation.ts):
  # SETUID/SETGID switch to the session user (and its groups), KILL signals
  # session processes, CHOWN hands clones to the session user, DAC_OVERRIDE
  # reads Claude Code's transcripts in the session user's configuration
  # directory. Nothing else.
  capabilities = [
    "CAP_CHOWN"
    "CAP_DAC_OVERRIDE"
    "CAP_KILL"
    "CAP_SETGID"
    "CAP_SETUID"
  ];

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
      ++ sessionCfg.packages;
    pathsToLink = [
      "/bin"
      "/share"
    ];
  };

  # The session user's PATH as a NixOS login shell would have it (the
  # wrappers, then environment.profiles: the user's own Nix profiles, its
  # per-user profile, the default and the system profile), followed by the
  # tools above. Directories the session user can write are fine here: this
  # PATH is only used by session processes; the API's own PATH (the unit's
  # `path`) holds store paths only.
  expandProfile =
    p:
    builtins.replaceStrings
      [
        "$HOME"
        "$USER"
        "\${XDG_STATE_HOME}"
      ]
      [
        sessionHome
        sessionUser
        "${sessionHome}/.local/state"
      ]
      p;
  sessionPath = concatStringsSep ":" (
    [ "/run/wrappers/bin" ]
    ++ map (p: "${expandProfile p}/bin") config.environment.profiles
    ++ [ "${sessionEnv}/bin" ]
  );

  sessionShell =
    if existingUser && userDef != null && userDef.shell != null then
      utils.toShellPath userDef.shell
    else
      "${pkgs.bashInteractive}/bin/bash";

  # Secret files, handed to the service as systemd credentials: systemd reads
  # them as root (so sops-nix may keep them root-only) and provides copies
  # readable only by the API user under $CREDENTIALS_DIRECTORY.
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

  # Like the image entrypoint: refuse to start when the session user can read
  # a secret file at its original place (the copies systemd provides are the
  # API user's only).
  checkSecrets = pkgs.writeShellScript "claude-remote-manager-check-secrets" ''
    set -eu
    status=0
    for file in ${lib.escapeShellArgs secretPaths}; do
      if ${pkgs.util-linux}/bin/setpriv --reuid=${sessionUser} --regid=${sessionGroup} --init-groups \
          --inh-caps=-all --no-new-privs -- ${pkgs.coreutils}/bin/test -r "$file"; then
        echo "error: the session user ${sessionUser} can read $file; make it readable by root (or the API user ${cfg.user}) only" >&2
        status=1
      fi
    done
    exit $status
  '';

  claudeMd = pkgs.runCommand "claude-remote-manager-claude-md" { } ''
    mkdir $out
    substitute ${../claude-md/nixos.md} nixos.md \
      --replace-fail @workspace@ ${lib.escapeShellArg workspaceDir} \
      --replace-fail @dataDir@ ${lib.escapeShellArg cfg.dataDir} \
      --replace-fail @claudeConfig@ ${lib.escapeShellArg cfg.claudeConfigDir} \
      --replace-fail @home@ ${lib.escapeShellArg sessionHome} \
      --replace-fail @sessionUser@ ${lib.escapeShellArg sessionUser} \
      --replace-fail @writablePaths@ ${
        lib.escapeShellArg (
          if sessionCfg.writablePaths == [ ] then
            ""
          else
            " and " + concatStringsSep ", " (map (p: "`${p}`") sessionCfg.writablePaths)
        )
      }
    { cat nixos.md; echo; cat ${../claude-md/core.md}; } > $out/CLAUDE.md
    ${lib.optionalString (cfg.extraInstructions != "") ''
      { echo; cat ${pkgs.writeText "extra-instructions.md" cfg.extraInstructions}; } >> $out/CLAUDE.md
    ''}
  '';

  # The address processes on this machine use to reach the API (the git
  # credential helper of session clones).
  internalHost =
    if
      lib.elem cfg.listenAddress [
        "0.0.0.0"
        "127.0.0.1"
        "::"
        "localhost"
      ]
    then
      "127.0.0.1"
    else if lib.hasInfix ":" cfg.listenAddress then
      "[${cfg.listenAddress}]"
    else
      cfg.listenAddress;

  list = concatStringsSep ",";

  locale = {
    LANG = config.i18n.defaultLocale;
    LOCALE_ARCHIVE = "${config.i18n.glibcLocales}/lib/locale/locale-archive";
  };

  serviceEnvironment = {
    NODE_ENV = "production";
    PORT = toString cfg.port;
    LISTEN_ADDRESS = cfg.listenAddress;
    INTERNAL_API_URL = "http://${internalHost}:${toString cfg.port}";
    PROCESS_ISOLATION = "separate-users";
    SESSION_USER = sessionUser;
    SESSION_PATH = sessionPath;
    SHELL = sessionShell;
    DATA_DIR = cfg.dataDir;
    DB_DIR = dbDir;
    WORKSPACE_DIR = workspaceDir;
    CLAUDE_CONFIG_DIR = cfg.claudeConfigDir;
    GIT_CONFIG_GLOBAL = "${gitDir}/gitconfig";
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

  # Logging in to Claude (and any other Claude Code command) as the session
  # user, with the service's configuration directory and PATH.
  claudeCommand = pkgs.writeShellScriptBin "claude-remote-manager-claude" ''
    set -eu
    env=(
      HOME=${lib.escapeShellArg sessionHome}
      USER=${lib.escapeShellArg sessionUser}
      LOGNAME=${lib.escapeShellArg sessionUser}
      PATH=${lib.escapeShellArg sessionPath}
      SHELL=${lib.escapeShellArg sessionShell}
      CLAUDE_CONFIG_DIR=${lib.escapeShellArg cfg.claudeConfigDir}
      LANG=${lib.escapeShellArg locale.LANG}
      LOCALE_ARCHIVE=${lib.escapeShellArg locale.LOCALE_ARCHIVE}
      SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
      TERM="''${TERM:-xterm-256color}"
    )
    claude=${cfg.package}/libexec/claude-remote-manager/claude
    if [ "$(id -u)" = 0 ]; then
      exec ${pkgs.util-linux}/bin/setpriv --reuid=${sessionUser} --regid=${sessionGroup} --init-groups \
        --inh-caps=-all -- ${pkgs.coreutils}/bin/env -i "''${env[@]}" "$claude" "$@"
    elif [ "$(id -un)" = ${lib.escapeShellArg sessionUser} ]; then
      exec ${pkgs.coreutils}/bin/env -i "''${env[@]}" "$claude" "$@"
    else
      echo "Run this as root (sudo $(basename "$0") ...) or as ${sessionUser}." >&2
      exit 1
    fi
  '';

  secretFileType = types.nullOr (
    types.str
    // {
      description = "absolute path of a file outside the Nix store";
    }
  );
  isSecretPath = p: p == null || (lib.hasPrefix "/" p && !lib.hasPrefix builtins.storeDir p);
in
{
  options.services.claude-remote-manager = {
    enable = mkEnableOption "Claude Remote Manager, a web frontend for Claude Code sessions";

    package = mkOption {
      type = types.package;
      description = "The claude-remote-manager package (the flake's `packages.<system>.default`).";
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
        front or `auth.mode = "cloudflare-access"`: the app runs Claude with
        broad tool permissions.
      '';
    };

    dataDir = mkOption {
      type = types.str;
      default = "/var/lib/claude-remote-manager";
      example = "/persist/var/lib/claude-remote-manager";
      description = ''
        All state: `db/` (database, the API's files, generated VAPID keys),
        `workspace/` (mirrors, session clones, scratch directories; one file
        system), `git/` (the API's SSH key and git configuration), `claude/`
        (Claude Code's configuration directory with the login, transcripts
        and memory) and, for a session user created by this module, `home/`.
        On a machine with impermanence point it below the persistent volume.
      '';
    };

    claudeConfigDir = mkOption {
      type = types.str;
      default = "${cfg.dataDir}/claude";
      defaultText = lib.literalExpression ''"''${dataDir}/claude"'';
      description = ''
        Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`) for the
        sessions: login, settings, transcripts, auto-memory. Owned by the
        session user (mode 0700); the API reads it with its capabilities.
      '';
    };

    user = mkOption {
      type = types.str;
      default = "claude-remote-manager";
      description = "System user the API runs as; created by the module.";
    };

    group = mkOption {
      type = types.str;
      default = "claude-remote-manager";
      description = "Primary group of the API user; created by the module.";
    };

    sessionUser = {
      name = mkOption {
        type = types.str;
        default = "claude";
        description = ''
          User everything a session runs as (Claude Code, setup scripts, git
          in session clones). Never the API user or root.
        '';
      };

      create = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Whether the module creates the session user (recommended). Set to
          false to run sessions as a user the configuration defines itself,
          e.g. a login user: the module then neither creates nor changes it
          or its home, and sessions get everything that user can do.
        '';
      };

      group = mkOption {
        type = types.str;
        default = "claude";
        description = "Primary group of a session user created by the module.";
      };

      home = mkOption {
        type = types.str;
        default = if existingUser && userDef != null then userDef.home else "${cfg.dataDir}/home";
        defaultText = lib.literalExpression ''"''${dataDir}/home" (created user), the user's home (existing user)'';
        description = ''
          Home directory of the session user (`HOME` of sessions: caches,
          the user's Nix profile). Writable for sessions.
        '';
      };

      extraGroups = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "dialout" ];
        description = ''
          Supplementary groups of a session user created by the module, e.g.
          to give sessions access to devices or shared directories.
        '';
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

      writablePaths = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "/srv/shared" ];
        description = ''
          Further existing paths sessions (and the API) may write. The rest of
          the file system is read-only for the service apart from the data
          directory and the session user's home; home directories of other
          users are hidden.
        '';
      };
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
        PR_POLL_INTERVAL_SECONDS = "300";
      };
      description = ''
        Further variables of the API (see the README's table), e.g.
        `SESSION_STALL_MINUTES`. Never secrets: these end up in the Nix store.
      '';
    };

    environmentFiles = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "/run/secrets/crm/env" ];
      description = ''
        Files with `NAME=value` lines added to the API's environment (read by
        systemd as root), for secrets that only exist as variables, e.g.
        `CLAUDE_CODE_OAUTH_TOKEN` or `CRM_SECRET_*`. Checked like the other
        secret files.
      '';
    };

    hiddenPaths = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "/persist/var/lib/sops-nix/key.txt" ];
      description = ''
        Further paths made inaccessible inside the service (to the API and
        to sessions), e.g. key material on disk that the API's
        DAC_OVERRIDE capability could otherwise read. sops-nix's
        `/run/secrets`, its age key file (when `sops.age.keyFile` is set),
        `/etc/shadow` and the SSH host keys are hidden already.
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
        Markdown appended to the managed `CLAUDE.md` every session loads
        (`/etc/claude-code/CLAUDE.md` inside the service only), after the
        module's description of the machine.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion =
          cfg.auth.mode != "cloudflare-access" || (cfg.auth.teamDomain != null && cfg.auth.audiences != [ ]);
        message = "services.claude-remote-manager: auth.mode = \"cloudflare-access\" needs auth.teamDomain and auth.audiences.";
      }
      {
        assertion =
          cfg.preview.url == null || cfg.auth.mode != "cloudflare-access" || cfg.preview.accessAudiences != [ ];
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
        assertion = cfg.github.appId == null || cfg.github.privateKeyFile != null || cfg.environmentFiles != [ ];
        message = "services.claude-remote-manager: github.appId needs github.privateKeyFile.";
      }
      {
        assertion = cfg.vapid.publicKey == null || cfg.vapid.privateKeyFile != null || cfg.environmentFiles != [ ];
        message = "services.claude-remote-manager: vapid.publicKey needs vapid.privateKeyFile.";
      }
      {
        assertion = lib.all isSecretPath secretPaths;
        message = "services.claude-remote-manager: secret files (github.privateKeyFile, github.webhookSecretFile, ntfy.tokenFile, vapid.privateKeyFile, environmentFiles) must be absolute paths outside the Nix store, e.g. sops-nix's /run/secrets/...";
      }
      {
        assertion = lib.hasPrefix "/" cfg.dataDir && lib.hasPrefix "/" cfg.claudeConfigDir && lib.hasPrefix "/" sessionHome;
        message = "services.claude-remote-manager: dataDir, claudeConfigDir and sessionUser.home must be absolute paths.";
      }
      {
        assertion = sessionUser != cfg.user && sessionUser != "root" && cfg.user != "root";
        message = "services.claude-remote-manager: the API user and the session user must be two different users, neither of them root.";
      }
      {
        assertion = !existingUser || userDef != null;
        message = "services.claude-remote-manager: sessionUser.create = false needs users.users.${sessionUser} defined elsewhere in the configuration.";
      }
      {
        assertion = !existingUser || sessionCfg.extraGroups == [ ];
        message = "services.claude-remote-manager: sessionUser.extraGroups only applies to a session user the module creates; give an existing user its groups where it is defined.";
      }
      {
        assertion = !(lib.hasPrefix "${cfg.claudeConfigDir}/" "${cfg.dataDir}/") && cfg.claudeConfigDir != dbDir && cfg.claudeConfigDir != gitDir && cfg.claudeConfigDir != workspaceDir;
        message = "services.claude-remote-manager: claudeConfigDir must not be the data directory or one of the API's directories in it.";
      }
    ];

    warnings =
      let
        nixSettings = config.nix.settings;
        trusted = nixSettings.trusted-users or [ ];
        allowed = nixSettings.allowed-users or [ "*" ];
        groupsOf = if userDef == null then [ ] else [ userDef.group ] ++ userDef.extraGroups;
        isTrusted = lib.elem sessionUser trusted || lib.any (g: lib.elem "@${g}" trusted) groupsOf;
      in
      optional isTrusted "services.claude-remote-manager: the session user ${sessionUser} is a trusted Nix user; sessions can then act as root through the Nix daemon."
      ++ optional (
        config.nix.enable && !(lib.elem "*" allowed || lib.elem sessionUser allowed || lib.any (g: lib.elem "@${g}" allowed) groupsOf)
      ) "services.claude-remote-manager: the session user ${sessionUser} is not in nix.settings.allowed-users; sessions cannot use Nix."
      ++ optional (
        cfg.auth.mode == "none" && (cfg.openFirewall || !lib.elem cfg.listenAddress [ "127.0.0.1" "::1" "localhost" ])
      ) "services.claude-remote-manager: auth.mode = \"none\" on a non-loopback address: everyone who reaches the port controls the sessions.";

    users.users = {
      ${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
        home = gitDir;
        description = "Claude Remote Manager API";
      };
    }
    // optionalAttrs (!existingUser) {
      ${sessionUser} = {
        isSystemUser = true;
        group = sessionCfg.group;
        home = sessionHome;
        createHome = false;
        shell = pkgs.bashInteractive;
        extraGroups = sessionCfg.extraGroups;
        description = "Claude Remote Manager sessions";
      };
    };
    users.groups = {
      ${cfg.group} = { };
    }
    // optionalAttrs (!existingUser) { ${sessionCfg.group} = { }; };

    # Directories and their owners; `d` adjusts mode and owner of the
    # directory itself, never recursively.
    systemd.tmpfiles.settings."10-claude-remote-manager" =
      let
        dir = user: group: mode: {
          d = { inherit user group mode; };
        };
      in
      {
        ${cfg.dataDir} = dir "root" "root" "0755";
        ${dbDir} = dir cfg.user cfg.group "0700";
        ${gitDir} = dir cfg.user cfg.group "0700";
        "${gitDir}/ssh" = dir cfg.user cfg.group "0700";
        "${gitDir}/.ssh".L.argument = "ssh";
        "${gitDir}/gitconfig".f = {
          user = cfg.user;
          group = cfg.group;
          mode = "0600";
        };
        ${workspaceDir} = dir cfg.user cfg.group "0755";
        "${workspaceDir}/repos" = dir cfg.user cfg.group "0755";
        "${workspaceDir}/sessions" = dir cfg.user cfg.group "0755";
        "${workspaceDir}/scratch" = dir cfg.user cfg.group "0755";
        ${cfg.claudeConfigDir} = dir sessionUser sessionGroup "0700";
      }
      // optionalAttrs (!existingUser) {
        ${sessionHome} = dir sessionUser sessionGroup "0700";
      };

    environment.systemPackages = [ claudeCommand ];

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
      # The API's own PATH: store paths only. It resolves setpriv and its own
      # git and find commands here; sessions get SESSION_PATH instead.
      path = with pkgs; [
        util-linux
        git
        openssh
        coreutils
        findutils
        bash
      ];
      environment = serviceEnvironment;
      restartTriggers = [ claudeMd ];

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        ExecStartPre = optional (secretPaths != [ ]) "+${checkSecrets}";
        ExecStart = lib.getExe cfg.package;
        WorkingDirectory = cfg.dataDir;
        Restart = "on-failure";
        RestartSec = 5;
        # The API stops its Claude Code processes on SIGTERM (up to 5 s).
        TimeoutStopSec = 30;
        LoadCredential = lib.mapAttrsToList (name: v: "${name}:${v.file}") secrets;
        EnvironmentFile = cfg.environmentFiles;

        # Privileges: exactly the capabilities the API needs, ambient so they
        # survive the exec into Node.js; it drops them for every process it
        # starts (setpriv --inh-caps=-all --ambient-caps=-all --no-new-privs).
        AmbientCapabilities = capabilities;
        CapabilityBoundingSet = capabilities;
        NoNewPrivileges = true;
        SecureBits = "noroot-locked";

        # File system: read-only except the data directory, the session
        # user's home and the configured paths. This also bounds the API's
        # DAC_OVERRIDE. Other homes are hidden.
        ProtectSystem = "strict";
        ProtectHome = "tmpfs";
        ReadWritePaths = [ cfg.dataDir ];
        # Bind mounts, so that they work below the hidden /home too.
        BindPaths = [
          sessionHome
        ]
        ++ lib.optional (!lib.hasPrefix "${cfg.dataDir}/" cfg.claudeConfigDir) cfg.claudeConfigDir
        ++ sessionCfg.writablePaths;
        # The managed CLAUDE.md for sessions, inside the service only.
        BindReadOnlyPaths = [ "${claudeMd}:/etc/claude-code" ];
        # Secret stores and keys of the machine, which DAC_OVERRIDE could read
        # otherwise; the service's own secrets arrive as credentials.
        InaccessiblePaths = map (p: "-${p}") (
          [
            "/run/secrets"
            "/run/secrets.d"
            "/run/secrets-for-users"
            "/run/secrets-for-users.d"
            "/etc/shadow"
            "/etc/gshadow"
            "/var/lib/sops-nix"
          ]
          ++ map (k: k.path) (config.services.openssh.hostKeys or [ ])
          ++ lib.optional (
            (config.sops.age.keyFile or null) != null
          ) config.sops.age.keyFile
          ++ cfg.hiddenPaths
        );
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        # Session processes see only the session user's processes, the API
        # only its own; /proc/net (the socket table the API reads to refuse
        # session processes) stays.
        ProtectProc = "invisible";
        LockPersonality = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        RemoveIPC = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "~@clock"
          "~@cpu-emulation"
          "~@module"
          "~@obsolete"
          "~@raw-io"
          "~@reboot"
          "~@swap"
        ];
        UMask = "0022";

        # Deliberately off, because sessions are real development
        # environments on this machine:
        # - PrivateNetwork/IPAddressDeny: sessions reach the network and the
        #   home network like any program on the machine.
        # - PrivateUsers: the API switches to a real user.
        # - RestrictNamespaces: browsers (Chromium's sandbox), bubblewrap and
        #   container tools in sessions need user namespaces.
        # - MemoryDenyWriteExecute: Node.js and other JIT runtimes.
        # - ProcSubset=pid: would hide /proc/net.
        # - A @system-service allowlist for system calls: debuggers, tracing
        #   and the like in sessions.
      };
    };
  };
}
