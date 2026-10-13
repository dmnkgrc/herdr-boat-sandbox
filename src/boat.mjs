#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GIT = `set -eo pipefail
git() { command git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
`;

const CHECKOUT = `${GIT}
url=$1 branch=$2
[ -d "$HOME/project/.git" ] || git clone -q "$url" "$HOME/project"
cd "$HOME/project"
git fetch -q origin "$branch"
if git show-ref -q --verify "refs/heads/$branch"; then
  git checkout -q "$branch"
  git merge -q --ff-only "origin/$branch"
else
  git checkout -q -b "$branch" --track "origin/$branch"
fi
grep -qs herdr-boat "$HOME/.bashrc" || echo 'cd "$HOME/project" 2>/dev/null # herdr-boat' >> "$HOME/.bashrc"
`;

const PUSH = `${GIT}
cd "$HOME/project"
git push -q origin "$1"
git status --porcelain | wc -l
`;

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

const git = (root, ...args) => run("git", ["-C", root, ...args]).trim();
const dirty = (root) => git(root, "status", "--porcelain").split("\n").filter(Boolean).length;

function branchOf(root) {
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "HEAD") throw new Error("Check out a branch first; the box gets it through origin.");
  return branch;
}

// ponytail: assumes SSH remotes, including host aliases like git@work-github:org/repo, are GitHub.
function cloneUrl(root) {
  const url = git(root, "remote", "get-url", "origin");
  const slug = url.match(/^(?:[^/@]+@[^:/]+:|ssh:\/\/[^/]+\/)(.+?)(?:\.git)?$/)?.[1];
  return slug ? `https://github.com/${slug}.git` : url;
}

export function sync(id, root) {
  const branch = branchOf(root);
  console.log(`Pushing ${branch} and checking it out in ${id}…`);
  const pushed = spawnSync("git", ["-C", root, "rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`], {
    encoding: "utf8",
  }).stdout.trim();
  if (pushed !== git(root, "rev-parse", "HEAD")) git(root, "push", "-q", "origin", branch);
  remote(id, CHECKOUT, [cloneUrl(root), branch]);
  return dirty(root);
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
    record = { sandboxId: create(root), worktreePath: root };
    writeRecord(file, record);
  } else if (RESUMABLE.includes(state)) {
    console.log(`Resuming ${record.sandboxId}…`);
    run("boat", ["resume", record.sandboxId, ...flags(settings(root), ["ttl"])]);
  } else {
    started = false;
  }
  const unpushed = sync(record.sandboxId, root);
  if (started) {
    const resume = spawnSync("boat", ["ssh", record.sandboxId, "--", "bash", "-c", RESUME], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (resume.status !== 0) console.error(".agents/resume failed; continuing.");
  }
  return { ...record, started, unpushed };
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
  const branch = branchOf(root);
  const left = Number(remote(sandboxId, PUSH, [branch]).trim());
  git(root, "pull", "-q", "--ff-only", "origin", branch);
  return `Pulled ${branch} from ${sandboxId}.${left ? ` ${left} uncommitted changes stayed in the box.` : ""}`;
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
    const { sandboxId, started, unpushed } = ensureSandbox(root);
    console.log(`Connecting ${sandboxId} to herdr…`);
    const label = connect(sandboxId, root, started);
    const left = unpushed ? ` ${unpushed} uncommitted changes stayed in the local worktree.` : "";
    notify(`${sandboxId} is ready: select "${label}" in the sidebar.${left}`);
  } catch (error) {
    console.error(error.message);
    process.stdout.write("Press Enter to close.");
    await once(process.stdin, "data");
    process.exit(1);
  }
}

const worktreeRoot = (cwd) => git(cwd, "rev-parse", "--show-toplevel");

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
