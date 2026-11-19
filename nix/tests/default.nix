# Flake checks: the package, NixOS VM tests of the module (a new install,
# and an upgrade from the data directory of an earlier version), and
# evaluation checks of the module's assertions.
{
  self,
  nixpkgs,
  pkgs,
  system,
}:
let
  inherit (nixpkgs) lib;
  vmTest = import ./vm.nix { inherit self pkgs lib; };

  # Evaluates a configuration with the module and returns the messages of
  # the failed assertions.
  failedAssertions =
    settings:
    let
      eval = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          self.nixosModules.default
          {
            boot.loader.grub.enable = false;
            fileSystems."/" = {
              device = "/dev/null";
              fsType = "ext4";
            };
            system.stateVersion = "26.05";
            users.users.alice.isNormalUser = true;
            services.claude-remote-manager = {
              enable = true;
              user = "alice";
            }
            // settings;
          }
        ];
      };
    in
    {
      messages = map (a: a.message) (lib.filter (a: !a.assertion) eval.config.assertions);
      builds = (builtins.tryEval eval.config.system.build.toplevel.drvPath).success;
      inherit (eval.config.systemd.services.claude-remote-manager) environment;
    };

  expectFailure =
    name: settings: expected:
    let
      result = failedAssertions settings;
      found = lib.any (m: lib.hasInfix expected m) result.messages;
    in
    pkgs.runCommand "claude-remote-manager-eval-${name}" { } (
      if found && !result.builds then
        ''
          echo "refused as expected: ${expected}" > $out
        ''
      else
        throw "configuration ${name} was not refused with '${expected}' (messages: ${builtins.toJSON result.messages}, evaluates: ${lib.boolToString result.builds})"
    );

  accepted =
    let
      result = failedAssertions {
        auth = {
          mode = "cloudflare-access";
          teamDomain = "example.cloudflareaccess.com";
          audiences = [ "app-aud" ];
        };
        preview = {
          url = "https://preview.example.com";
          accessAudiences = [ "preview-aud" ];
        };
        github = {
          appId = 123456;
          privateKeyFile = "/run/secrets/crm/github-app-key";
          trustedBots = [
            "my-reviewer[bot]"
            "ci-helper[bot]"
          ];
        };
      };
    in
    pkgs.runCommand "claude-remote-manager-eval-accepted" { } (
      if result.messages != [ ] then
        throw "a valid configuration was refused: ${builtins.toJSON result.messages}"
      else if result.environment.PR_TRUSTED_BOTS or null != "my-reviewer[bot],ci-helper[bot]" then
        throw "github.trustedBots did not reach PR_TRUSTED_BOTS: ${
          builtins.toJSON (result.environment.PR_TRUSTED_BOTS or null)
        }"
      else
        "touch $out"
    );
in
{
  package = self.packages.${system}.default;

  vm-install = vmTest {
    name = "install";
    upgrade = false;
  };

  vm-upgrade = vmTest {
    name = "upgrade";
    upgrade = true;
  };

  eval-valid-configuration = accepted;

  eval-cloudflare-access-without-audience = expectFailure "cloudflare-access-without-audience" {
    auth = {
      mode = "cloudflare-access";
      teamDomain = "example.cloudflareaccess.com";
    };
  } "needs auth.teamDomain and auth.audiences";

  eval-preview-without-audience = expectFailure "preview-without-audience" {
    auth = {
      mode = "cloudflare-access";
      teamDomain = "example.cloudflareaccess.com";
      audiences = [ "app-aud" ];
    };
    preview.url = "https://preview.example.com";
  } "needs preview.accessAudiences";

  eval-secret-in-store = expectFailure "secret-in-store" {
    auth.mode = "none";
    ntfy = {
      url = "https://ntfy.example.com";
      topic = "crm";
      tokenFile = "${pkgs.writeText "token" "not-a-secret"}";
    };
  } "must be absolute paths outside the Nix store";

  eval-missing-user = expectFailure "missing-user" {
    auth.mode = "none";
    user = "nobody-defined";
  } "needs users.users.nobody-defined defined";

  eval-removed-session-user = expectFailure "removed-session-user" {
    auth.mode = "none";
    sessionUser.create = false;
  } "no longer has any effect";

  eval-root = expectFailure "root" {
    auth.mode = "none";
    user = "root";
  } "must not run as root";
}
