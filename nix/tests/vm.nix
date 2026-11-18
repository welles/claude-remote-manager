# NixOS VM test of the module as deployed: the service runs as the login
# user `alice`, secrets as root-only files (as sops-nix provides them), a
# session started through the API with a stand-in for Claude Code that
# records what a session process sees and can do. `upgrade` starts from the
# data directory of an earlier version of the module (other owners, Claude
# Code's own configuration directory in the data directory). No network
# and no Claude account are needed.
{
  self,
  pkgs,
  lib,
}:
{
  name,
  upgrade,
}:
let
  dataDir = "/var/lib/claude-remote-manager";
  user = "alice";
  home = "/home/alice";
  credentials = "/run/credentials/claude-remote-manager.service";
  machineAddress = "192.168.1.2";
  # A transcript of a session created by the earlier version.
  oldProject = "-var-lib-claude-remote-manager-workspace-sessions-old-acme-app";
  oldTranscript = "0d6f6b8e-3f43-4a77-9d0e-1c2b3a4d5e6f.jsonl";

  # Stands in for Claude Code: the API starts it with a session's
  # environment. It writes what it sees into the user's home and stays
  # alive like a Claude Code process.
  fakeClaude = pkgs.writeShellScript "fake-claude" ''
    out="$HOME/fake-claude"
    mkdir -p "$out"
    n="$$"
    # The SDK's initialize request (system prompt, settings) on stdin.
    cat > "$out/$n.stdin" <&0 &
    printf '%s\n' "$@" > "$out/$n.args"
    { id -u; id -un; } > "$out/$n.id"
    env > "$out/$n.env"
    for tool in figlet cowsay git nix node bash curl sudo hello; do
      command -v "$tool" || echo "missing $tool"
    done > "$out/$n.which"
    curl -s -w '\n%{http_code}\n' http://127.0.0.1:8080/api/sessions > "$out/$n.api-loopback" 2>&1
    curl -s -w '\n%{http_code}\n' -H 'Host: localhost' http://${machineAddress}:8080/api/sessions \
      > "$out/$n.api-own-address" 2>&1
    # A process that left the API's process tree is still in its cgroup.
    setsid sh -c "curl -s -w '\n%{http_code}\n' http://127.0.0.1:8080/api/sessions > '$out/$n.api-detached' 2>&1" < /dev/null &
    { sudo -n cat /etc/shadow > /dev/null; echo "exit $?"; } > "$out/$n.sudo" 2>&1
    { test -b /dev/vda; echo "exit $?"; } > "$out/$n.device" 2>&1
    { cat ${dataDir}/db/claude-remote-manager.sqlite > /dev/null; echo "exit $?"; } > "$out/$n.db" 2>&1
    echo "from-session" > "/tmp/crm-session-$n"
    printf 'protocol=https\nhost=github.com\n\n' | git credential fill > "$out/$n.credential" 2>&1
    git config --show-origin --get-all credential.helper > "$out/$n.helpers" 2>&1
    touch "$out/$n.done"
    exec sleep 3600
  '';
in
pkgs.testers.runNixOSTest {
  name = "claude-remote-manager-${name}";

  nodes.machine =
    { config, pkgs, ... }:
    {
      imports = [ self.nixosModules.default ];
      documentation.enable = false;

      virtualisation = {
        memorySize = 3072;
        cores = 2;
        diskSize = 4096;
      };
      networking.interfaces.eth1.ipv4.addresses = lib.mkForce [
        {
          address = machineAddress;
          prefixLength = 24;
        }
      ];
      nix.settings.experimental-features = [
        "nix-command"
        "flakes"
      ];
      # A tool from the system profile, which sessions must find.
      environment.systemPackages = [
        pkgs.figlet
        pkgs.jq
      ];

      users.users.alice = {
        isNormalUser = true;
        extraGroups = [ "wheel" ];
        # A tool from the user's own profile.
        packages = [ pkgs.cowsay ];
      };
      security.sudo.wheelNeedsPassword = false;

      # Secrets as sops-nix puts them: files owned by root, mode 0400. The
      # user's git configuration with a credential helper; for `upgrade`,
      # the data directory as the earlier module left it.
      systemd.services.prepare = {
        wantedBy = [ "multi-user.target" ];
        after = [ "systemd-tmpfiles-setup.service" ];
        before = [ "claude-remote-manager.service" ];
        requiredBy = [ "claude-remote-manager.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        path = [ pkgs.openssl ];
        script = ''
          install -d -m 0755 /run/secrets/crm
          (
            umask 0377
            openssl genrsa -out /run/secrets/crm/github-app-key 2048
            echo "webhook-secret-0123456789abcdef" > /run/secrets/crm/github-webhook-secret
            echo "ntfy-token-SECRET-1f2e3d4c" > /run/secrets/crm/ntfy-token
          )
          cat > ${home}/.gitconfig <<'EOF'
          [credential]
          	helper = "!f() { echo username=alice; echo password=from-alice-gitconfig; }; f"
          EOF
          chown alice:users ${home}/.gitconfig
        ''
        + lib.optionalString upgrade ''
          # Owners of the earlier version: the API user and the session user.
          old=${dataDir}
          install -d -o 990 -g 990 -m 0700 $old/claude $old/claude/projects/${oldProject} \
            $old/claude/repository-memory/repo-1
          echo '{"type":"user"}' > $old/claude/projects/${oldProject}/${oldTranscript}
          echo remember > $old/claude/repository-memory/repo-1/MEMORY.md
          echo '{}' > $old/claude/.credentials.json
          chown -R 990:990 $old/claude
          chmod 0600 $old/claude/.credentials.json
          install -d -o 990 -g 990 -m 0755 $old/workspace/sessions/old/acme/app
          echo work > $old/workspace/sessions/old/acme/app/file
          chown 990:990 $old/workspace/sessions/old/acme/app/file
          echo old > $old/db/old-file
          chown 991:991 $old/db/old-file
          chmod 0600 $old/db/old-file
          install -d -o 991 -g 991 -m 0700 $old/git/ssh
        '';
      };

      services.claude-remote-manager = {
        enable = true;
        user = "alice";
        auth.mode = "none";
        # Reachable on the machine's own address too, to test refusals there.
        listenAddress = "0.0.0.0";
        github = {
          appId = 12345;
          privateKeyFile = "/run/secrets/crm/github-app-key";
          webhookSecretFile = "/run/secrets/crm/github-webhook-secret";
        };
        ntfy = {
          url = "http://127.0.0.1:9";
          topic = "crm-test";
          tokenFile = "/run/secrets/crm/ntfy-token";
        };
        packages = [ pkgs.hello ];
        environment = {
          CLAUDE_CODE_EXECUTABLE = "${fakeClaude}";
          SESSION_IDLE_TIMEOUT_MINUTES = "0";
        };
        extraInstructions = ''
          ## Test

          MARKER-EXTRA-INSTRUCTIONS
        '';
      };
    };

  testScript =
    { nodes, ... }:
    let
      package = nodes.machine.services.claude-remote-manager.package;
    in
    ''
      import json, shlex

      DATA = "${dataDir}"
      USER = "${user}"
      HOME = "${home}"
      API = "http://127.0.0.1:8080"
      AS_USER = f"su - {USER} -c"

      def api(method, path, body=None):
          data = f"-H 'Content-Type: application/json' -d {shlex.quote(json.dumps(body))}" if body is not None else ""
          out = machine.succeed(f"curl -sS -X {method} {data} -w '\\n%{{http_code}}' {API}{path}")
          text, status = out.rsplit("\n", 1)
          return int(status), text

      machine.start()
      machine.wait_for_unit("claude-remote-manager.service")
      machine.wait_for_open_port(8080)

      with subtest("health, web app and service worker are served"):
          status, text = api("GET", "/api/health")
          assert status == 200, text
          print(text)
          machine.succeed(f"curl -sf {API}/ | grep -q '<app-root'")
          machine.succeed(f"curl -sf {API}/sw.js -o /dev/null")
          machine.succeed(f"curl -sf {API}/manifest.webmanifest -o /dev/null")

      with subtest("the service runs as the user, without sandbox"):
          pid = machine.succeed("systemctl show -p MainPID --value claude-remote-manager").strip()
          status = machine.succeed(f"cat /proc/{pid}/status")
          print(status)
          uid = machine.succeed(f"id -u {USER}").strip()
          assert f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}" in status, "the service does not run as the user"
          assert "CapEff:\t0000000000000000" in status, "CapEff"
          assert "NoNewPrivs:\t0" in status, "NoNewPrivs"
          assert "Seccomp:\t0" in status, "Seccomp"
          # The machine's mount namespace: no private /tmp, nothing hidden.
          assert machine.succeed(f"readlink /proc/{pid}/ns/mnt") == machine.succeed("readlink /proc/1/ns/mnt")

      with subtest("the data directory is the user's"):
          machine.succeed(f"test \"$(stat -c %U:%a {DATA})\" = {USER}:700")
          machine.succeed(f"test \"$(stat -c %U {DATA}/db/claude-remote-manager.sqlite)\" = {USER}")
          machine.succeed(f"test \"$(cat {DATA}/.owner)\" = {USER}")
          machine.succeed(f"test -z \"$(find {DATA} ! -user {USER} -print -quit)\"")

      with subtest("secrets arrive as credentials readable by the user"):
          machine.succeed(f"{AS_USER} 'cat ${credentials}/ntfy-token' | grep -q ntfy-token-SECRET")
          machine.fail(f"{AS_USER} 'cat /run/secrets/crm/ntfy-token'")

      with subtest("processes the service started are refused by the management API, the user's own are not"):
          for url, host in ((API, ""), ("http://${machineAddress}:8080", "-H 'Host: localhost'")):
              out = machine.succeed(f"{AS_USER} \"curl -s {host} -o /dev/null -w '%{{http_code}}' {url}/api/sessions\"")
              assert out == "200", out
              out = machine.succeed(f"curl -s {host} -o /dev/null -w '%{{http_code}}' {url}/api/sessions")
              assert out == "200", out

      with subtest("the Claude Code binary of the package runs as the user"):
          version = machine.succeed(f"{AS_USER} '${package}/libexec/claude-remote-manager/claude --version'")
          print(version)
          assert "Claude Code" in version, version

      with subtest("a local project: mirror, session clone, session process"):
          status, text = api("PUT", "/api/settings", {"gitAuthorName": "Test Owner", "gitAuthorEmail": "owner@example.com"})
          assert status == 200, text
          status, text = api("POST", "/api/sessions", {"prompt": "hello", "newProject": {"name": "demo"}, "permissionMode": "bypassPermissions"})
          assert status in (200, 201, 204), (status, text)
          session = json.loads(text)
          sid = session["id"]
          assert session["permissionMode"] == "bypassPermissions", session
          machine.wait_until_succeeds(f"ls {HOME}/fake-claude/*.done", timeout=120)
          mirror = f"{DATA}/workspace/repos/local/demo"
          clone = machine.succeed(f"ls -d {DATA}/workspace/sessions/*/local/demo").strip()
          for path in (mirror, clone):
              machine.succeed(f"test \"$(stat -c %U {path})\" = {USER}")
          machine.succeed(f"test \"$(git -C {mirror} rev-parse main)\" = \"$({AS_USER} 'git -C {clone} rev-parse HEAD')\"")

      with subtest("what the session process saw and could do"):
          print(machine.succeed(f"ls -la {HOME}/fake-claude; tail -n +1 {HOME}/fake-claude/*"))
          prefix = machine.succeed(f"ls {HOME}/fake-claude/*.done | head -n 1").strip()[: -len(".done")]
          def seen(kind):
              return machine.succeed(f"cat {prefix}.{kind}")
          ident = seen("id").split()
          assert ident[-1] == USER, ident
          env = seen("env")
          names = {line.split("=", 1)[0] for line in env.splitlines() if "=" in line}
          # The user's own configuration: no CLAUDE_CONFIG_DIR, no global
          # git configuration of the app, no app secrets.
          for forbidden in ("CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "CRM_SECRET_"):
              assert not any(n.startswith(forbidden) for n in names), f"{forbidden} reached the session"
          assert "ntfy-token-SECRET" not in env, "a secret value reached the session"
          assert f"HOME={HOME}" in env and f"USER={USER}" in env, "HOME or USER"
          path = next(line for line in env.splitlines() if line.startswith("PATH="))
          assert path.startswith("PATH=/run/wrappers/bin:"), path
          assert "/run/current-system/sw/bin" in path and f"/etc/profiles/per-user/{USER}/bin" in path, path
          which = seen("which")
          print(which)
          assert "missing" not in which, which
          assert "/run/wrappers/bin/sudo" in which and "/etc/profiles/per-user/alice/bin/cowsay" in which, which
          args = seen("args")
          print(args)
          assert "--allow-dangerously-skip-permissions" in args and "bypassPermissions" in args, args
          assert "--strict-mcp-config" not in args, args
          machine.wait_until_succeeds(f"grep -q MARKER-EXTRA-INSTRUCTIONS {prefix}.stdin", timeout=30)
          stdin = seen("stdin")
          assert "NixOS machine" in stdin and "## Git and GitHub" in stdin, stdin[:2000]
          # Session processes are refused by the API, also detached ones.
          for kind in ("api-loopback", "api-own-address"):
              out = seen(kind)
              assert "session_process_refused" in out and out.strip().endswith("403"), (kind, out)
          machine.wait_until_succeeds(f"grep -q 403 {prefix}.api-detached", timeout=30)
          # What the user can do in a terminal, sessions can do.
          for kind in ("sudo", "device", "db"):
              out = seen(kind)
              assert "exit 0" in out, (kind, out)
          machine.succeed(f"grep -q from-session /tmp/crm-session-{prefix.rsplit('/', 1)[1]}")
          # Git in the session clone uses the user's credential helper.
          assert "password=from-alice-gitconfig" in seen("credential"), seen("credential")
          assert f"{HOME}/.gitconfig" in seen("helpers"), seen("helpers")
          machine.fail("test -e /etc/claude-code/CLAUDE.md")

      with subtest("the API reads files in the clone"):
          machine.succeed(f"{AS_USER} 'echo note-content > {clone}/note.txt'")
          status, text = api("GET", f"/api/sessions/{sid}/files?query=note")
          assert status == 200 and "note.txt" in text, text
          status, text = api("GET", f"/api/sessions/{sid}/diff")
          assert status == 200 and "note.txt" in text, text

      with subtest("ending and deleting the session removes its clone"):
          status, text = api("POST", f"/api/sessions/{sid}/end", {})
          assert status in (200, 201, 204), (status, text)
          machine.wait_until_succeeds(f"! pgrep -u {USER} -f fake-claude", timeout=60)
          status, text = api("POST", f"/api/sessions/{sid}/delete", {"confirm": True, "acceptLoss": True})
          assert status in (200, 201, 204), (status, text)
          machine.wait_until_succeeds(f"! test -e {clone}", timeout=60)
          machine.succeed(f"test -d {mirror}")

      with subtest("the service did not fail"):
          machine.succeed("systemctl is-active claude-remote-manager.service")
          print(machine.succeed("journalctl -u claude-remote-manager.service --no-pager | tail -n 40"))
    ''
    + lib.optionalString upgrade ''

      with subtest("an earlier version's data was taken over"):
          transcript = f"{HOME}/.claude/projects/${oldProject}/${oldTranscript}"
          machine.succeed(f"test \"$(stat -c %U {transcript})\" = {USER}")
          machine.succeed(f"grep -q user {transcript}")
          # Copied, not moved; a marker keeps it from running again.
          machine.succeed(f"test -f {DATA}/claude/projects/${oldProject}/${oldTranscript}")
          machine.succeed(f"test -f {DATA}/claude/COPIED-TO-CLAUDE-CONFIG.txt")
          machine.succeed(f"grep -q remember {DATA}/memory/repo-1/MEMORY.md")
          machine.succeed(f"test \"$(stat -c %U {DATA}/workspace/sessions/old/acme/app/file)\" = {USER}")
          machine.succeed(f"{AS_USER} 'cat {DATA}/db/old-file'")
          # The old login is not taken over: the user's own ~/.claude counts.
          machine.fail(f"test -e {HOME}/.claude/.credentials.json")
          print(machine.succeed("journalctl -u claude-remote-manager.service --no-pager | grep -i -e 'giving' -e 'copied'"))
    '';
}
