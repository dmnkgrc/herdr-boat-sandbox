#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRELUDE = `set -eo pipefail
export GIT_AUTHOR_NAME=herdr-boat GIT_AUTHOR_EMAIL=herdr-boat@localhost
export GIT_COMMITTER_NAME=herdr-boat GIT_COMMITTER_EMAIL=herdr-boat@localhost
snapshot() {
  export GIT_INDEX_FILE=.git/herdr-boat-index
  cp .git/index "$GIT_INDEX_FILE"
  git add -A
  git commit-tree "$(git write-tree)" -m herdr-boat
}
`;

const SEED = `${PRELUDE}
rm -rf "$HOME/project"
mkdir -p "$HOME/project"
cd "$HOME/project"
git init -q -b "$1"
tar -x
git add -A -f
git commit -q --allow-empty -m "herdr-boat: $1 @ $2"
grep -qs herdr-boat "$HOME/.bashrc" || echo 'cd "$HOME/project" 2>/dev/null # herdr-boat' >> "$HOME/.bashrc"
`;

const overlayScript = (withTar) => `${PRELUDE}
cd "$HOME/project"
${withTar ? "tar -x" : ""}
[ $# -eq 0 ] || rm -f -- "$@"
git update-ref refs/herdr/pulled "$(snapshot)"
`;

const PULL = `${PRELUDE}
cd "$HOME/project"
commit=$(snapshot)
git update-ref refs/herdr/pending "$commit"
git diff --binary refs/herdr/pulled "$commit"
`;

const ACK = `cd "$HOME/project" && git update-ref refs/herdr/pulled refs/herdr/pending`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(
      `${command} ${args[0]}: ${detail || `exit code ${result.status}`}`,
    );
  }
  return result.stdout;
}

const remote = (id, script, args = [], options = {}) =>
  run("boat", ["ssh", id, "--", "bash", "-c", script, "bash", ...args], options);

function remoteFrom(file, id, script, args) {
  const fd = fs.openSync(file, "r");
  try {
    return remote(id, script, args, { stdio: [fd, "pipe", "pipe"] });
  } finally {
    fs.closeSync(fd);
  }
}

const split = (output) => output.split("\0").filter(Boolean);

function stateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set; run this through Herdr.");
  return dir;
}

function recordPath(root) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return path.join(stateDir(), "boxes", `${path.basename(root)}-${hash}.json`);
}

const readRecord = (file) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;

function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function config() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  const file = dir && path.join(dir, "config.json");
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

const flags = (settings, keys) =>
  keys.flatMap((key) =>
    settings[key] === undefined ? [] : [`--${key}`, String(settings[key])],
  );

function sandboxState(id) {
  const result = spawnSync("boat", ["info", id, "--json"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) {
    const info = JSON.parse(result.stdout);
    return (info.sandbox ?? info).state;
  }
  const output = `${result.stdout}${result.stderr}`;
  if (/not.?found|404/i.test(output)) return undefined;
  throw new Error(`boat info: ${output.trim() || `exit code ${result.status}`}`);
}

function create() {
  const events = run("boat", ["new", "--json", ...flags(config(), ["type", "ttl", "from", "environment"])])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const id = events.find((event) => event.event === "ready")?.id;
  if (!id) throw new Error("boat new finished without a ready sandbox.");
  return id;
}

export function upload(id, root) {
  const git = (...args) => run("git", ["-C", root, ...args]);
  if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"]).status !== 0)
    throw new Error("The worktree has no commit yet; commit something first.");
  const sha = git("rev-parse", "--short", "HEAD").trim();
  const ref = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  const branch = ref === "HEAD" ? "herdr-boat" : ref;
  const deleted = new Set(split(git("ls-files", "-z", "--deleted")));
  const changed = split(
    git("ls-files", "-z", "--modified", "--others", "--exclude-standard"),
  ).filter((file) => !deleted.has(file));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-boat-"));
  try {
    const head = path.join(tmp, "head.tar");
    git("archive", "--format=tar", "-o", head, "HEAD");
    remoteFrom(head, id, SEED, [branch, sha]);
    if (!changed.length) return void remote(id, overlayScript(false), [...deleted]);
    const overlay = path.join(tmp, "overlay.tar");
    run("tar", ["-c", "--no-xattrs", "-f", overlay, "--null", "-T", "-"], {
      cwd: root,
      input: changed.join("\0"),
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    remoteFrom(overlay, id, overlayScript(true), [...deleted]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function ensureSandbox(root) {
  const file = recordPath(root);
  let record = readRecord(file);
  const state = record && sandboxState(record.sandboxId);
  if (record && (state === undefined || state === "cancelled")) {
    console.log(`Sandbox ${record.sandboxId} is gone; creating a new one.`);
    record = undefined;
  }
  if (!record) {
    console.log("Creating a boat sandbox…");
    record = { sandboxId: create(), worktreePath: root, seeded: false };
    writeRecord(file, record);
  } else if (state === "archived" || state === "archiving") {
    console.log(`Resuming ${record.sandboxId}…`);
    run("boat", ["resume", record.sandboxId, ...flags(config(), ["ttl"])]);
  }
  if (!record.seeded) {
    console.log(`Uploading the worktree to ${record.sandboxId}…`);
    upload(record.sandboxId, root);
    record.seeded = true;
    writeRecord(file, record);
  }
  return record;
}

function requireRecord(root) {
  const record = readRecord(recordPath(root));
  if (!record) throw new Error("This worktree has no boat sandbox.");
  return record;
}

export function pull(root) {
  const { sandboxId } = requireRecord(root);
  const patch = remote(sandboxId, PULL, [], { encoding: "buffer" });
  if (!patch.length) return "Nothing to pull.";
  const file = path.join(stateDir(), "patches", `${sandboxId}-${Date.now()}.patch`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, patch);
  try {
    run("git", ["-C", root, "apply", "--binary", file]);
  } catch (error) {
    throw new Error(
      `${error.message}\nThe patch is kept at ${file}; apply it with git apply --3way.`,
    );
  }
  remote(sandboxId, ACK);
  fs.rmSync(file);
  return `Pulled ${sandboxId} into ${path.basename(root)}.`;
}

function status(root) {
  const record = readRecord(recordPath(root));
  if (!record) return "This worktree has no boat sandbox.";
  return `${record.sandboxId}: ${sandboxState(record.sandboxId) ?? "gone"}`;
}

function stop(root) {
  const { sandboxId } = requireRecord(root);
  run("boat", ["stop", sandboxId]);
  return `Stopping ${sandboxId}; open it again to resume.`;
}

const eventPaths = (value) =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([key, item]) =>
        key === "path" && typeof item === "string" ? [item] : eventPaths(item),
      )
    : [];

function teardown() {
  const paths = new Set(eventPaths(JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}")));
  const dir = path.join(stateDir(), "boxes");
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const { sandboxId, worktreePath } = readRecord(file);
    if (!paths.has(worktreePath)) continue;
    try {
      const state = sandboxState(sandboxId);
      if (state && !["archived", "archiving", "cancelled"].includes(state))
        run("boat", ["stop", sandboxId]);
      fs.rmSync(file);
      notify(`Stopped ${sandboxId} for the removed worktree. Delete it with: boat delete ${sandboxId} --yes`);
    } catch (error) {
      notify(`Couldn't stop ${sandboxId}: ${error.message}`);
    }
  }
}

function notify(message) {
  console.log(message);
  spawnSync(process.env.HERDR_BIN_PATH || "herdr", [
    "notification", "show", "boat", "--body", message,
  ]);
}

function openPane(root, targetPane) {
  run(process.env.HERDR_BIN_PATH || "herdr", [
    "plugin", "pane", "open",
    "--plugin", "boat",
    "--entrypoint", "box",
    "--placement", "split",
    "--direction", "down",
    "--cwd", root,
    "--focus",
    ...(targetPane ? ["--target-pane", targetPane] : []),
  ]);
}

async function box() {
  try {
    const { sandboxId } = ensureSandbox(worktreeRoot(process.cwd()));
    process.exitCode = spawnSync("boat", ["ssh", sandboxId], { stdio: "inherit" }).status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.stdout.write("Press Enter to close.");
    await once(process.stdin, "data");
    process.exit(1);
  }
}

const worktreeRoot = (cwd) => run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).trim();

const ACTIONS = { pull, status, stop };

async function main(command) {
  if (command === "box") return box();
  if (command === "teardown") return teardown();
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  const cwd = context.focused_pane_cwd ?? context.workspace_cwd ?? process.cwd();
  try {
    const root = worktreeRoot(cwd);
    if (command === "open") openPane(root, context.focused_pane_id);
    else if (ACTIONS[command]) notify(ACTIONS[command](root));
    else throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    notify(error.message);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  await main(process.argv[2]);
