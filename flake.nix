{
  description = "Claude Remote Manager: self-hosted web frontend for Claude Code sessions, as a Nix package and NixOS module";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [ "x86_64-linux" ];
      forAllSystems = lib.genAttrs systems;

      # The bundled Claude Code is unfree; allowed here for this package only,
      # so consumers using the flake's package need no unfree setting.
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg: lib.getName pkg == "claude-remote-manager";
        };

      # Only what the build reads, so README or CI changes do not rebuild.
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./apps
          ./libs
          ./assets
          ./package.json
          ./package-lock.json
          ./nx.json
          ./tsconfig.base.json
          ./jest.config.ts
          ./jest.preset.js
          ./eslint.config.mjs
        ];
      };

      date = self.lastModifiedDate or "19700101000000";
      commitTime =
        "${builtins.substring 0 4 date}-${builtins.substring 4 2 date}-${builtins.substring 6 2 date}"
        + "T${builtins.substring 8 2 date}:${builtins.substring 10 2 date}:${builtins.substring 12 2 date}Z";

      packageFor =
        system:
        (pkgsFor system).callPackage ./nix/package.nix {
          inherit src commitTime;
          version = (lib.importJSON ./package.json).version;
          commit = self.rev or self.dirtyRev or "";
        };
    in
    {
      packages = forAllSystems (system: rec {
        claude-remote-manager = packageFor system;
        default = claude-remote-manager;
      });

      nixosModules.default =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.claude-remote-manager.package =
            lib.mkDefault
              self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      checks = forAllSystems (
        system:
        import ./nix/tests {
          inherit self nixpkgs system;
          pkgs = pkgsFor system;
        }
      );

      devShells = forAllSystems (system: {
        default = (pkgsFor system).mkShell {
          packages = with (pkgsFor system); [
            nodejs_24
            jq
          ];
        };
      });

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
