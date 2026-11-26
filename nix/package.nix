# The app as a Nix package: the built web app and the API bundle with its
# production dependencies (better-sqlite3 compiled for this Node.js, the
# Agent SDK's Claude Code binary made runnable on NixOS), migrations and the
# helper scripts. Used by the NixOS module (nix/module.nix).
{
  lib,
  stdenv,
  fetchNpmDeps,
  npmHooks,
  nodejs_24,
  nodejs-slim_24,
  jq,
  autoPatchelfHook,
  makeBinaryWrapper,
  procps,
  ripgrep,
  runCommand,
  src,
  version ? "0.0.0",
  commit ? "",
  commitTime ? "",
}:
let
  # Building needs npm; running only Node.js.
  nodejs = nodejs_24;
  runtimeNodejs = nodejs-slim_24;

  # The lockfile for this platform only. npm's platform packages (os, cpu
  # and libc fields) of other platforms are dropped, among them the Agent
  # SDK's Claude Code binaries of about 200 MB each, so the fixed-output
  # derivation below does not download all eight; so are the WebAssembly
  # fallback bindings (`*-wasm32-wasi`), which native bindings replace here
  # and whose peer dependencies npm cannot check offline. The repository's
  # lockfile stays as it is; the fetch and the build use this copy.
  npmPlatform =
    {
      x86_64-linux = {
        cpu = "x64";
        sdk = "linux-x64";
      };
    }
    .${stdenv.hostPlatform.system}
      or (throw "claude-remote-manager: unsupported system ${stdenv.hostPlatform.system}");

  lockfile =
    runCommand "claude-remote-manager-lockfile-${npmPlatform.sdk}" { nativeBuildInputs = [ jq ]; }
      ''
        mkdir $out
        jq --indent 2 --arg cpu ${npmPlatform.cpu} -f ${./lockfile-filter.jq} \
          ${src}/package-lock.json > $out/package-lock.json
      '';

  # The npm dependencies as a fixed-output derivation. When package-lock.json
  # changes, this hash changes: run nix/update-npm-deps-hash.sh (see
  # README.md, "Updating npm dependencies").
  npmDeps = fetchNpmDeps {
    name = "claude-remote-manager-npm-deps";
    src = lockfile;
    hash = (lib.importJSON ./npm-deps-hash.json).${stdenv.hostPlatform.system};
  };
in
stdenv.mkDerivation {
  pname = "claude-remote-manager";
  inherit version src npmDeps;

  nativeBuildInputs = [
    nodejs
    npmHooks.npmConfigHook
    autoPatchelfHook
    makeBinaryWrapper
  ];
  # Libraries of the native Node.js modules and the Claude Code binary
  # (autoPatchelfHook looks them up here).
  buildInputs = [ stdenv.cc.cc.lib ];
  # better-sqlite3 ships prebuilt modules for musl as well; never loaded here
  # (and removed from the output).
  autoPatchelfIgnoreMissingDeps = [ "libc.musl-x86_64.so.1" ];

  env = {
    NX_DAEMON = "false";
    NX_NO_CLOUD = "true";
    NX_SKIP_NX_CACHE = "true";
    NX_TUI = "false";
    NX_VERBOSE_LOGGING = "false";
    CI = "true";
  };

  postPatch = ''
    cp ${lockfile}/package-lock.json package-lock.json
  '';

  buildPhase = ''
    runHook preBuild

    # Prebuilt native programs of the build tools (Dart Sass, ...) expect a
    # FHS system; give them this system's loader and libraries.
    autoPatchelf node_modules

    npx nx run-many -t build -p web api --outputStyle=static

    # Production dependencies of the API, from the lockfile Nx generated for
    # it, out of the same offline npm cache. Install scripts stay off: the
    # one native module, better-sqlite3, ships Node-API prebuilds (ABI-stable
    # across Node.js versions, as the image uses them); autoPatchelf below
    # points the one for this platform to this system's libstdc++.
    pushd dist/apps/api
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    popd

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    app=$out/lib/claude-remote-manager
    mkdir -p $app $out/bin
    cp -r dist/apps/api/. $app/
    cp -r dist/apps/web/browser $app/public
    rm -f $app/package-lock.json
    # better-sqlite3: only this platform's prebuild, no sources.
    rm -rf $app/node_modules/better-sqlite3/{deps,src}
    find $app/node_modules/better-sqlite3/prebuilds -type f ! -name 'linux-${npmPlatform.cpu}.node' -delete

    claude=$(echo $app/node_modules/@anthropic-ai/claude-agent-sdk-${npmPlatform.sdk}/claude)
    test -x "$claude"

    makeWrapper ${lib.getExe runtimeNodejs} $out/bin/claude-remote-manager \
      --add-flags $app/main.js \
      --set-default NODE_ENV production \
      --set-default WEB_ROOT $app/public \
      --set-default CLAUDE_CODE_EXECUTABLE $out/libexec/claude-remote-manager/claude \
      --set-default APP_VERSION ${lib.escapeShellArg version} \
      --set-default APP_COMMIT ${lib.escapeShellArg commit} \
      --set-default APP_COMMIT_TIME ${lib.escapeShellArg commitTime}

    # Claude Code as the sessions run it: the SDK's binary (same version as
    # the SDK), never updating itself, with the system's ripgrep and ps as
    # fallbacks after the session's own PATH.
    mkdir -p $out/libexec/claude-remote-manager
    makeWrapper "$claude" $out/libexec/claude-remote-manager/claude \
      --set DISABLE_AUTOUPDATER 1 \
      --set DISABLE_INSTALLATION_CHECKS 1 \
      --set USE_BUILTIN_RIPGREP 0 \
      --suffix PATH : ${
        lib.makeBinPath [
          procps
          ripgrep
        ]
      }

    runHook postInstall
  '';

  # The Bun-compiled Claude Code binary carries its program after the ELF
  # image; stripping would cut it off. Only the interpreter is patched.
  dontStrip = true;

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME=$TMPDIR
    $out/libexec/claude-remote-manager/claude --version
    ${lib.getExe runtimeNodejs} -e "new (require('$out/lib/claude-remote-manager/node_modules/better-sqlite3'))(':memory:').exec('create virtual table t using fts5(x, tokenize=trigram)')"
    test -f $out/lib/claude-remote-manager/public/sw.js
    test -f $out/lib/claude-remote-manager/public/index.html
    test -f $out/lib/claude-remote-manager/assets/session-files.cjs
    test -f $out/lib/claude-remote-manager/assets/stop-processes-in.cjs
    ls $out/lib/claude-remote-manager/migrations/*.sql > /dev/null
    runHook postInstallCheck
  '';

  passthru = {
    inherit npmDeps lockfile;
    nodejs = runtimeNodejs;
  };

  meta = {
    description = "Self-hosted web frontend for managing Claude Code sessions";
    license = lib.licenses.unfree;
    platforms = [ "x86_64-linux" ];
    mainProgram = "claude-remote-manager";
  };
}
