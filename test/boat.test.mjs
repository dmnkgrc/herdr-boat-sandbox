import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSandbox, pull } from "../src/boat.mjs";

const FAKE_BOAT = `#!/usr/bin/env bash
case "$1" in
  new) echo "$*" > "$FAKE_HOME/new-args"; echo '{"event":"provisioning"}'; echo '{"event":"ready","id":"bx_test"}' ;;
  info) echo '{"sandbox":{"state":"'"$(cat "$FAKE_HOME/state" 2>/dev/null || echo ready)"'","sshEndpoint":"1.2.3.4:2222"}}' ;;
  ssh) shift 3; HOME="$FAKE_HOME" exec "$@" ;;
  stop) echo "$2" >> "$FAKE_HOME/stopped" ;;
  resume) echo ready > "$FAKE_HOME/state" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

const FAKE_HERDR = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_HOME/herdr.log"
[ "$1 $2" = "machine list" ] && cat "$FAKE_HOME/machines.json" 2>/dev/null
exit 0
`;

const FAKE_SSH = `#!/usr/bin/env bash
echo "hostname 1.2.3.4"
`;

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });

const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

function setup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "boat-test-")));
  const [bin, home, repo, config, origin] = ["bin", "home", "repo", "config", "origin.git"].map(
    (name) => path.join(tmp, name),
  );
  for (const dir of [bin, home, repo, config]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, "boat"), FAKE_BOAT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "herdr"), FAKE_HERDR, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local/bin/herdr"), "", { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_HOME = home;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(tmp, "state");
  process.env.HERDR_BIN_PATH = path.join(bin, "herdr");
  process.env.HERDR_PLUGIN_CONFIG_DIR = config;
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  write(repo, ".gitignore", "node_modules\n");
  write(repo, "kept.txt", "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feature");
  return { home, repo, config, origin, project: path.join(home, "project") };
}

const open = (repo) =>
  spawnSync("node", [path.resolve("src/boat.mjs"), "box"], { cwd: repo, encoding: "utf8" });

const commit = (dir, file, text) => {
  write(dir, file, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", file);
};

test("open pushes the branch for the box to check out, and pull brings the box's commits back", () => {
  const { repo, project } = setup();
  commit(repo, "kept.txt", "a2");
  write(repo, "local.txt", "uncommitted");

  assert.equal(ensureSandbox(repo).unpushed, 1);
  assert.equal(git(project, "branch", "--show-current"), "feature\n");
  assert.equal(git(project, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));
  assert.equal(fs.existsSync(path.join(project, "local.txt")), false);

  commit(project, "agent.txt", "d");
  write(project, "scratch.txt", "uncommitted");
  assert.equal(pull(repo), "Pulled feature from bx_test. 1 uncommitted changes stayed in the box.");
  assert.equal(read(repo, "agent.txt"), "d");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(project, "rev-parse", "HEAD"));

  commit(repo, "kept.txt", "a3");
  ensureSandbox(repo);
  assert.equal(read(project, "kept.txt"), "a3");

  git(repo, "remote", "set-url", "--push", "origin", "/nonexistent");
  ensureSandbox(repo);
});

test("open connects the box as a herdr machine and replaces it after a resume", () => {
  const { home, repo } = setup();
  const result = open(repo);
  assert.equal(result.status, 0, result.stderr);
  const conf = read(process.env.HERDR_PLUGIN_STATE_DIR, "ssh/bx_test.conf");
  assert.match(conf, /^Host boat-bx_test\n  HostName 1\.2\.3\.4\n  Port 2222\n/);
  assert.match(read(home, "herdr.log"), /^machine add --label boat repo boat-bx_test$/m);

  write(home, "state", "stopped");
  write(home, "machines.json", JSON.stringify([{ id: "m1", target: "boat-bx_test" }]));
  write(home, "herdr.log", "");
  assert.equal(open(repo).status, 0);
  assert.equal(read(home, "state"), "ready\n");
  assert.match(read(home, "herdr.log"), /^machine remove m1\nmachine add --label boat repo boat-bx_test$/m);
});

test("a box from a snapshot keeps its clone's ignored files when it switches branch", () => {
  const { repo, origin, project } = setup();
  git(path.dirname(project), "clone", "-q", origin, project);
  fs.mkdirSync(path.join(project, "node_modules"));
  write(project, "node_modules/dep.js", "dep");
  commit(repo, "feature.txt", "f");

  ensureSandbox(repo);
  assert.equal(git(project, "branch", "--show-current"), "feature\n");
  assert.equal(read(project, "feature.txt"), "f");
  assert.equal(read(project, "node_modules/dep.js"), "dep");
});

test("repo settings override shared ones, ttl defaults to four hours, and .agents/resume runs", () => {
  const { home, repo, config } = setup();
  write(config, "config.json", JSON.stringify({ type: "small", repos: { repo: { from: "cortea" } } }));
  fs.mkdirSync(path.join(repo, ".agents"));
  write(repo, ".agents/resume", "#!/bin/sh\ntouch \"$HOME/resumed\"\n");
  fs.chmodSync(path.join(repo, ".agents/resume"), 0o755);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "resume");

  ensureSandbox(repo);
  assert.equal(read(home, "new-args"), "new --json --type small --ttl 14400 --from cortea\n");
  assert.equal(fs.existsSync(path.join(home, "resumed")), true);
});
