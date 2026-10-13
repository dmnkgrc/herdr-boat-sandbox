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
branch=$1 sha=$2
shift 2
mkdir -p "$HOME/project"
cd "$HOME/project"
if [ -d .git ]; then
  git clean -fdq
  git ls-files -z | xargs -0 rm -rf --
  rm -rf .git
fi
git init -q -b "$branch"
tar -x
git add -A
[ $# -eq 0 ] || git --literal-pathspecs add -f -- "$@"
git commit -q --allow-empty -m "herdr-boat: $branch @ $sha"
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

const RESUME = `cd "$HOME/project" && if [ -x .agents/resume ]; then .agents/resume; fi`;

const MACHINE_SETUP = `[ -x "$HOME/.local/bin/herdr" ] || curl -fsSL https://herdr.dev/install.sh | sh >&2
pgrep -x herdr >/dev/null || rm -f "$HOME"/.config/herdr/herdr*.sock "$HOME/.config/herdr/session.json"`;

const RESUMABLE = ["stopped", "stopping", "archived", "archiving"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim() || jsonError(String(result.stdout ?? ""));
    throw new Error(
      `${command} ${args[0]}: ${detail || `exit code ${result.status}`}`,
    );
  }
  return result.stdout;
}

function jsonError(stdout) {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(last).error ?? last;
  } catch {
    return last;
  }
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

const repoName = (root) =>
  path.basename(
    path.dirname(
      run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    ),
  );

function settings(root) {
  const { repos = {}, ...shared } = config();
  return { ttl: 4 * 60 * 60, ...shared, ...repos[repoName(root)] };
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

function create(root) {
  const events = run("boat", ["new", "--json", ...flags(settings(root), ["type", "ttl", "from", "environment"])])
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
  const ignored = split(git("ls-files", "-z", "--cached", "--ignored", "--exclude-standard"));
  // ponytail: tracked-but-ignored files go as args; ship them in the tar if a repo has thousands.
  const forced = ignored.length
    ? split(git("--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...ignored))
    : [];
  const changed = split(
    git("ls-files", "-z", "--modified", "--others", "--exclude-standard"),
  ).filter((file) => !deleted.has(file));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-boat-"));
  try {
    const head = path.join(tmp, "head.tar");
    git("archive", "--format=tar", "-o", head, "HEAD");
    remoteFrom(head, id, SEED, [branch, sha, ...forced]);
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
  let started = true;
  const state = record && sandboxState(record.sandboxId);
  if (record && (state === undefined || state === "cancelled")) {
    console.log(`Sandbox ${record.sandboxId} is gone; creating a new one.`);
    forget(record.sandboxId);
    record = undefined;
  }
  if (!record) {
    console.log("Creating a boat sandbox…");
    record = { sandboxId: create(root), worktreePath: root, seeded: false };
    writeRecord(file, record);
  } else if (RESUMABLE.includes(state)) {
    console.log(`Resuming ${record.sandboxId}…`);
    run("boat", ["resume", record.sandboxId, ...flags(settings(root), ["ttl"])]);
  } else {
    started = false;
  }
  if (!record.seeded) {
    console.log(`Uploading the worktree to ${record.sandboxId}…`);
    upload(record.sandboxId, root);
    record.seeded = true;
    writeRecord(file, record);
  }
  if (started) {
    const resume = spawnSync("boat", ["ssh", record.sandboxId, "--", "bash", "-c", RESUME], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (resume.status !== 0) console.error(".agents/resume failed; continuing.");
  }
  return { ...record, started };
}

const herdr = (...args) => run(process.env.HERDR_BIN_PATH || "herdr", args);
const sshHost = (id) => `boat-${id}`;
const sshDir = () => path.join(stateDir(), "ssh");
const machineFor = (id) =>
  JSON.parse(herdr("machine", "list", "--json") || "[]").find(
    (machine) => machine.target === sshHost(id),
  );

// ponytail: mirrors the options `boat ssh` passes to ssh; if Boat changes them, plain ssh fails loudly.
function sshConfig(id) {
  const info = JSON.parse(run("boat", ["info", id, "--json"]));
  const endpoint = (info.sandbox ?? info).sshEndpoint;
  if (!endpoint) throw new Error(`boat info ${id} has no SSH endpoint.`);
  const at = endpoint.lastIndexOf(":");
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 24);
  const ssh = path.join(os.homedir(), ".ssh");
  return `Host ${sshHost(id)}
  HostName ${endpoint.slice(0, at).replace(/^\[|\]$/g, "")}
  Port ${endpoint.slice(at + 1)}
  User user
  IdentityFile "${path.join(ssh, "ascii_box_ed25519")}"
  IdentitiesOnly yes
  UserKnownHostsFile "${path.join(ssh, "ascii_sandbox_known_hosts", hash)}"
  HostKeyAlias ascii-sandbox-${hash}
  StrictHostKeyChecking yes
`;
}

export function connect(id, root, started) {
  // Installs herdr in the box and refreshes Boat's known_hosts entry, which changes on resume.
  remote(id, MACHINE_SETUP);
  fs.mkdirSync(sshDir(), { recursive: true });
  fs.writeFileSync(path.join(sshDir(), `${id}.conf`), sshConfig(id));
  if (new RegExp(`^hostname ${sshHost(id)}$`, "m").test(run("ssh", ["-G", sshHost(id)])))
    throw new Error(
      `ssh can't see the box. Add this line to the top of ~/.ssh/config:\nInclude "${sshDir()}/*.conf"`,
    );
  const label = `boat ${path.basename(root)}`;
  const existing = machineFor(id);
  if (existing && !started) return label;
  // A resumed box has no herdr server; only `machine add` starts one, so replace the profile.
  if (existing) herdr("machine", "remove", existing.id);
  herdr("machine", "add", "--label", label, sshHost(id));
  return label;
}

function forget(id) {
  const machine = machineFor(id);
  if (machine) herdr("machine", "remove", machine.id);
  fs.rmSync(path.join(sshDir(), `${id}.conf`), { force: true });
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
  forget(sandboxId);
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
      if (state && ![...RESUMABLE, "cancelled"].includes(state)) run("boat", ["stop", sandboxId]);
      forget(sandboxId);
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
    const root = worktreeRoot(process.cwd());
    const { sandboxId, started } = ensureSandbox(root);
    console.log(`Connecting ${sandboxId} to herdr…`);
    const label = connect(sandboxId, root, started);
    notify(`${sandboxId} is ready: select "${label}" in the sidebar.`);
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
  // Panes inherit the launching pane's PATH, which may lack the Boat installer's bin dir.
  process.env.PATH = `${process.env.PATH}${path.delimiter}${path.join(os.homedir(), ".ascii", "bin")}`;
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
