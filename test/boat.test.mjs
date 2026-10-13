import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSandbox, pull } from "../src/boat.mjs";

const FAKE_BOAT = `#!/usr/bin/env bash
case "$1" in
  new) echo '{"event":"provisioning"}'; echo '{"event":"ready","id":"bx_test"}' ;;
  info) echo '{"id":"bx_test","state":"ready"}' ;;
  ssh) shift 3; HOME="$FAKE_HOME" exec "$@" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });

test("seeds the live worktree and pulls the sandbox's changes back", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "boat-test-")));
  const [bin, home, repo] = ["bin", "home", "repo"].map((name) => path.join(tmp, name));
  for (const dir of [bin, home, repo]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, "boat"), FAKE_BOAT, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_HOME = home;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(tmp, "state");

  const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
  const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
  git(repo, "init", "-q", "-b", "feature");
  write(repo, ".gitignore", "secret\n");
  write(repo, "kept.txt", "a");
  write(repo, "removed.txt", "b");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  write(repo, "kept.txt", "a2");
  fs.rmSync(path.join(repo, "removed.txt"));
  write(repo, "new.txt", "c");
  write(repo, "secret", "x");

  ensureSandbox(repo);
  const project = path.join(home, "project");
  assert.equal(git(project, "status", "--porcelain"), git(repo, "status", "--porcelain"));
  assert.equal(read(project, "kept.txt"), "a2");
  assert.equal(fs.existsSync(path.join(project, "secret")), false);

  write(project, "kept.txt", "a3");
  write(project, "agent.txt", "d");
  fs.rmSync(path.join(project, "new.txt"));
  pull(repo);
  assert.equal(read(repo, "kept.txt"), "a3");
  assert.equal(read(repo, "agent.txt"), "d");
  assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
  assert.equal(pull(repo), "Nothing to pull.");
});
