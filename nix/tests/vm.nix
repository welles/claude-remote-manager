# NixOS VM test of the module as deployed: secrets as root-only files (as
# sops-nix provides them), separate users, a session started through the API
# with a stand-in for Claude Code that records what a session process sees
# and can do. No network and no Claude account are needed.
{
  self,
  pkgs,
  lib,
}:
{
  name,
  # false: the module creates the session user `claude`; true: sessions run
  # as the login user `alice`, defined outside the module.
  existingUser,
}:
let
  dataDir = "/var/lib/claude-remote-manager";
  apiUser = "claude-remote-manager";
  sessionUser = if existingUser then "alice" else "claude";
  sessionHome = if existingUser then "/home/alice" else "${dataDir}/home";
  credentials = "/run/credentials/claude-remote-manager.service";
  machineAddress = "192.168.1.2";

  # Stands in for Claude Code: the API starts it as the session user, with a
  # session's environment, in the service's sandbox. It writes what it sees
  # into the session user's home and stays alive like a Claude Code process.
  fakeClaude = pkgs.writeShellScript "fake-claude" ''
    out="$HOME/fake-claude"
    mkdir -p "$out"
    n="$$"
    { id -u; id -un; } > "$out/$n.id"
    env > "$out/$n.env"
    { tr '\0' '\n' < /proc/self/environ; echo "exit $?"; } > "$out/$n.environ" 2>&1
    for tool in figlet cowsay git nix node bash curl hello; do
      command -v "$tool" || echo "missing $tool"
    done > "$out/$n.which"
    cat /etc/claude-code/CLAUDE.md > "$out/$n.claude-md" 2>&1
    curl -s -w '\n%{http_code}\n' http://127.0.0.1:8080/api/sessions > "$out/$n.api-loopback" 2>&1
    curl -s -w '\n%{http_code}\n' -H 'Host: localhost' http://${machineAddress}:8080/api/sessions \
      > "$out/$n.api-own-address" 2>&1
    { cat ${credentials}/ntfy-token; echo "exit $?"; } > "$out/$n.credential" 2>&1
    { cat /run/secrets/crm/ntfy-token; echo "exit $?"; } > "$out/$n.secret" 2>&1
    { cat ${dataDir}/db/claude-remote-manager.sqlite > /dev/null; echo "exit $?"; } > "$out/$n.db" 2>&1
    { sudo -n true; echo "exit $?"; } > "$out/$n.sudo" 2>&1
    { setpriv --reuid=0 true; echo "exit $?"; } > "$out/$n.setuid" 2>&1
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

      users.users = lib.mkIf existingUser {
        alice = {
          isNormalUser = true;
          extraGroups = [ "users" ];
          # A tool from the user's own profile.
          packages = [ pkgs.cowsay ];
        };
      };

      # Secrets as sops-nix puts them: files owned by root, mode 0400.
      systemd.services.fake-sops = {
        wantedBy = [ "multi-user.target" ];
        before = [ "claude-remote-manager.service" ];
        requiredBy = [ "claude-remote-manager.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        path = [ pkgs.openssl ];
        script = ''
          install -d -m 0755 /run/secrets/crm
          umask 0377
          openssl genrsa -out /run/secrets/crm/github-app-key 2048
          echo "webhook-secret-0123456789abcdef" > /run/secrets/crm/github-webhook-secret
          echo "ntfy-token-SECRET-1f2e3d4c" > /run/secrets/crm/ntfy-token
        '';
      };

      services.claude-remote-manager = {
        enable = true;
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
        sessionUser =
          if existingUser then
            {
              name = "alice";
              create = false;
            }
          else
            {
              packages = [ pkgs.cowsay ];
              extraGroups = [ "dialout" ];
            };
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
      USER = "${sessionUser}"
      HOME = "${sessionHome}"
      API = "http://127.0.0.1:8080"
      AS_SESSION = f"setpriv --reuid={USER} --regid=$(id -g {USER}) --init-groups --"

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

      with subtest("users, capabilities and hardening of the service"):
          pid = machine.succeed("systemctl show -p MainPID --value claude-remote-manager").strip()
          status = machine.succeed(f"cat /proc/{pid}/status")
          print(status)
          uid = machine.succeed("id -u ${apiUser}").strip()
          assert f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}" in status, "the API does not run as its own user"
          # CHOWN, DAC_OVERRIDE, KILL, SETGID, SETUID and nothing else
          for field in ("CapEff", "CapPrm", "CapAmb", "CapBnd"):
              assert f"{field}:\t00000000000000e3" in status, f"{field} is not exactly the five capabilities"
          assert "NoNewPrivs:\t1" in status, "NoNewPrivs"
          assert "Seccomp:\t2" in status, "Seccomp"
          print(machine.succeed("systemd-analyze security claude-remote-manager.service || true"))

      with subtest("database and the API's files are the API user's"):
          machine.succeed(f"test \"$(stat -c %U:%a {DATA}/db)\" = ${apiUser}:700")
          machine.succeed(f"test \"$(stat -c %U:%a {DATA}/git)\" = ${apiUser}:700")
          machine.succeed(f"test \"$(stat -c %U {DATA}/db/claude-remote-manager.sqlite)\" = ${apiUser}")
          machine.succeed(f"test \"$(stat -c %U:%a {DATA}/claude)\" = {USER}:700")
          machine.fail(f"{AS_SESSION} cat {DATA}/db/claude-remote-manager.sqlite")
          machine.fail(f"{AS_SESSION} ls {DATA}/db")
          machine.fail(f"{AS_SESSION} cat {DATA}/git/gitconfig")
          machine.fail(f"{AS_SESSION} cat {DATA}/db/vapid-keys.json")

      with subtest("secret files are unreadable for the session user"):
          for name in ("github-app-key", "github-webhook-secret", "ntfy-token"):
              machine.fail(f"{AS_SESSION} cat /run/secrets/crm/{name}")
              machine.fail(f"{AS_SESSION} cat ${credentials}/{name}")
          # The copies systemd hands the service are readable by the API user.
          print(machine.succeed("stat -c '%U:%G %a %n' ${credentials} ${credentials}/*; getfacl -p ${credentials} ${credentials}/ntfy-token 2>/dev/null || true"))
          machine.succeed("setpriv --reuid=${apiUser} --regid=${apiUser} --init-groups -- cat ${credentials}/ntfy-token | grep -q ntfy-token-SECRET")

      with subtest("session user processes are refused by the management API"):
          for url, host in ((API, ""), ("http://${machineAddress}:8080", "-H 'Host: localhost'")):
              out = machine.succeed(f"{AS_SESSION} curl -s {host} -w '\\n%{{http_code}}' {url}/api/sessions")
              assert out.endswith("\n403") and "session_process_refused" in out, out
              # Other users are not refused (AUTH_MODE=none in this test).
              out = machine.succeed(f"curl -s {host} -o /dev/null -w '%{{http_code}}' {url}/api/sessions")
              assert out == "200", out
          # The health check stays open for sessions.
          machine.succeed(f"{AS_SESSION} curl -sf {API}/api/health")

      with subtest("the Claude Code binary of the package runs as the session user"):
          version = machine.succeed(
              f"{AS_SESSION} env -i HOME={HOME} PATH=/run/current-system/sw/bin "
              "${package}/libexec/claude-remote-manager/claude --version"
          )
          print(version)
          assert "Claude Code" in version, version
          print(machine.succeed("claude-remote-manager-claude --version"))
          machine.succeed(f"test \"$(stat -c %U {DATA}/claude)\" = {USER}")

      with subtest("a local project: mirror, session clone, session process"):
          status, text = api("PUT", "/api/settings", {"gitAuthorName": "Test Owner", "gitAuthorEmail": "owner@example.com"})
          assert status == 200, text
          status, text = api("POST", "/api/sessions", {"prompt": "hello", "newProject": {"name": "demo"}})
          assert status in (200, 201, 204), (status, text)
          session = json.loads(text)
          sid = session["id"]
          machine.wait_until_succeeds(f"ls {HOME}/fake-claude/*.done", timeout=120)
          mirror = f"{DATA}/workspace/repos/local/demo"
          machine.succeed(f"test \"$(stat -c %U {mirror})\" = ${apiUser}")
          clone = machine.succeed(f"ls -d {DATA}/workspace/sessions/*/local/demo").strip()
          machine.succeed(f"test \"$(stat -c %U {clone})\" = {USER}")
          machine.succeed(f"test \"$(git -C {mirror} rev-parse main)\" = \"$({AS_SESSION} git -C {clone} rev-parse HEAD)\"")

      with subtest("what the session process saw"):
          print(machine.succeed(f"ls -la {HOME}/fake-claude; tail -n +1 {HOME}/fake-claude/*"))
          prefix = machine.succeed(f"ls {HOME}/fake-claude/*.done | head -n 1").strip()[: -len(".done")]
          def seen(kind):
              return machine.succeed(f"cat {prefix}.{kind}")
          ident = seen("id").split()
          print(ident)
          assert ident[-1] == USER, ident
          env = seen("env")
          print(env)
          names = {line.split("=", 1)[0] for line in env.splitlines() if "=" in line}
          for forbidden in ("CRM_SECRET_", "GITHUB_APP_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET_FILE",
                            "NTFY_TOKEN_FILE", "CREDENTIALS_DIRECTORY", "DB_DIR", "GIT_CONFIG_GLOBAL"):
              assert not any(n.startswith(forbidden) for n in names), f"{forbidden} reached the session"
          assert "ntfy-token-SECRET" not in env and "webhook-secret-0123" not in env, "a secret value reached the session"
          assert f"HOME={HOME}" in env and f"USER={USER}" in env, "HOME or USER"
          print(seen("environ"))
          path = next(line for line in env.splitlines() if line.startswith("PATH="))
          assert "/run/current-system/sw/bin" in path and f"/etc/profiles/per-user/{USER}/bin" in path, path
          assert "LOCALE_ARCHIVE=" in env and f"CLAUDE_CONFIG_DIR={DATA}/claude" in env, "LOCALE_ARCHIVE or CLAUDE_CONFIG_DIR"
          which = seen("which")
          print(which)
          assert "/run/current-system/sw/bin/figlet" in which, which
          assert "missing" not in which.replace("missing hello", ""), which
          if USER == "alice":
              assert "/etc/profiles/per-user/alice/bin/cowsay" in which, which
          for kind in ("api-loopback", "api-own-address"):
              out = seen(kind)
              assert "session_process_refused" in out and out.strip().endswith("403"), (kind, out)
          for kind in ("credential", "secret", "db", "sudo", "setuid"):
              out = seen(kind)
              assert "exit 0" not in out, (kind, out)
          claude_md = seen("claude-md")
          assert "NixOS machine" in claude_md and "MARKER-EXTRA-INSTRUCTIONS" in claude_md, claude_md
          assert "## Git and GitHub" in claude_md and f"`{USER}`" in claude_md, claude_md
          # The machine's /etc/claude-code is untouched; the file exists inside the service only.
          machine.fail("test -e /etc/claude-code/CLAUDE.md")

      with subtest("the API runs the file helper as the session user"):
          machine.succeed(f"{AS_SESSION} sh -c 'echo note-content > {clone}/note.txt'")
          status, text = api("GET", f"/api/sessions/{sid}/files?query=note")
          assert status == 200 and "note.txt" in text, text
          status, text = api("GET", f"/api/sessions/{sid}/diff")
          assert status == 200 and "note.txt" in text, text
          # A file the session user cannot read is not served through the helper.
          machine.succeed(f"echo private > {clone}/private.txt && chown root:root {clone}/private.txt && chmod 600 {clone}/private.txt")
          status, text = api("GET", f"/api/sessions/{sid}/files?query=private")
          assert status == 200, text

      with subtest("the service's namespace bounds the API's DAC_OVERRIDE"):
          ns = f"nsenter -t {pid} -m --"
          machine.fail(f"{ns} cat /run/secrets/crm/ntfy-token")
          # Hidden files are replaced by an empty inaccessible inode (root, as
          # here, may open it, but there is nothing in it).
          machine.succeed("test -s /etc/shadow")
          machine.succeed(f"{ns} test ! -s /etc/shadow")
          machine.fail(f"{ns} touch /etc/crm-test")
          machine.fail(f"{ns} touch /var/lib/crm-test")
          machine.succeed(f"{ns} touch {DATA}/workspace/.crm-test && rm {DATA}/workspace/.crm-test")
          machine.succeed(f"{ns} touch {HOME}/.crm-test && rm {HOME}/.crm-test")
          if USER != "alice":
              machine.succeed("useradd -m bob && echo hi > /home/bob/file")
              machine.fail(f"{ns} cat /home/bob/file")

      with subtest("ending and deleting the session removes its clone"):
          status, text = api("POST", f"/api/sessions/{sid}/end", {})
          assert status in (200, 201, 204), (status, text)
          machine.wait_until_succeeds(f"! pgrep -u {USER} -f fake-claude", timeout=60)
          machine.succeed(f"rm -f {clone}/private.txt")
          status, text = api("POST", f"/api/sessions/{sid}/delete", {"confirm": True, "acceptLoss": True})
          assert status in (200, 201, 204), (status, text)
          machine.wait_until_succeeds(f"! test -e {clone}", timeout=60)
          machine.succeed(f"test -d {mirror}")

      with subtest("the service did not fail"):
          machine.succeed("systemctl is-active claude-remote-manager.service")
          print(machine.succeed("journalctl -u claude-remote-manager.service --no-pager | tail -n 40"))
    ''
    + lib.optionalString existingUser ''

      with subtest("the login user and its home are left as they are"):
          machine.succeed("test \"$(stat -c %U:%a /home/alice)\" = alice:700")
          machine.succeed("getent passwd alice | grep -q ':/home/alice:'")
          machine.fail("getent passwd claude")
    '';
}
