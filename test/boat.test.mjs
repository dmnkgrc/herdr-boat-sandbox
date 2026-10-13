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
  const [bin, home, repo, config] = ["bin", "home", "repo", "config"].map((name) =>
    path.join(tmp, name),
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
  git(repo, "init", "-q", "-b", "feature");
  write(repo, "kept.txt", "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return { home, repo, config };
}

const open = (repo) =>
  spawnSync("node", [path.resolve("src/boat.mjs"), "box"], { cwd: repo, encoding: "utf8" });

test("seeds the live worktree and pulls the sandbox's changes back", () => {
  const { home, repo } = setup();
  write(repo, ".gitignore", "secret\n*.log\n");
  write(repo, "removed.txt", "b");
  write(repo, "tracked.log", "t");
  git(repo, "add", "-A");
  git(repo, "add", "-f", "tracked.log");
  git(repo, "commit", "-qm", "more");
  write(repo, "kept.txt", "a2");
  fs.rmSync(path.join(repo, "removed.txt"));
  write(repo, "new.txt", "c");
  write(repo, "secret", "x");

  ensureSandbox(repo);
  const project = path.join(home, "project");
  assert.equal(git(project, "status", "--porcelain"), git(repo, "status", "--porcelain"));
  assert.equal(read(project, "kept.txt"), "a2");
  assert.equal(fs.existsSync(path.join(project, "secret")), false);
  assert.match(git(project, "ls-files"), /tracked\.log/);

  write(project, "kept.txt", "a3");
  write(project, "agent.txt", "d");
  fs.rmSync(path.join(project, "new.txt"));
  pull(repo);
  assert.equal(read(repo, "kept.txt"), "a3");
  assert.equal(read(repo, "agent.txt"), "d");
  assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
  assert.equal(pull(repo), "Nothing to pull.");
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

test("a sandbox from a snapshot keeps its ignored files and drops the snapshot's tracked ones", () => {
  const { home, repo } = setup();
  write(repo, ".gitignore", "node_modules\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "ignore");
  const project = path.join(home, "project");
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  write(project, ".gitignore", "node_modules\n");
  write(project, "node_modules/dep.js", "dep");
  write(project, "stale.txt", "old");
  git(project, "init", "-q");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "snapshot");
  write(project, "junk.txt", "untracked");

  ensureSandbox(repo);
  assert.equal(read(project, "node_modules/dep.js"), "dep");
  assert.equal(fs.existsSync(path.join(project, "stale.txt")), false);
  assert.equal(fs.existsSync(path.join(project, "junk.txt")), false);
  assert.equal(git(project, "log", "--format=%s"), "herdr-boat: feature @ " + git(repo, "rev-parse", "--short", "HEAD"));
  assert.equal(git(project, "status", "--porcelain"), "");
  assert.equal(git(project, "ls-files"), ".gitignore\nkept.txt\n");
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
