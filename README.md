# herdr-boat-sandbox

A [herdr](https://herdr.dev) plugin that sends your worktree, **as it sits on disk, uncommitted changes and all**, into a [boat.dev](https://boat.dev) sandbox and drops you into its shell. It is a port of [herdr-e2b-sandbox](https://github.com/e2b-dev/herdr-e2b-sandbox) to Boat's persistent VMs.

Needs herdr ≥ 0.9, Node ≥ 22, git, tar, and the [`boat` CLI](https://docs.boat.dev/quickstart) on `PATH` and logged in (`boat login`). There are no npm dependencies.

```sh
curl -fsSL https://boat.dev/install | sh && boat login
herdr plugin link "$PWD" --enabled
```

## Actions

| Action | What it does |
| - | - |
| `boat.open` | Opens a pane below. It creates a sandbox for the worktree, or resumes the stopped one, uploads the worktree on first use, then runs `boat ssh` (the shell starts in `~/project`). |
| `boat.pull` | Applies the sandbox's changes since the last upload or pull to the local worktree as a git patch. |
| `boat.status` | Shows the sandbox ID and its state. |
| `boat.stop` | Stops the sandbox. Billing stops and the disk is kept; `open` resumes it. |
| `worktree.removed` | Stops the worktree's sandbox. It is **not** deleted; delete it with `boat delete <id> --yes`. |

Bind them in your herdr config the same way as the e2b plugin's `[[keys.command]]` entries.

## Config

`$HERDR_PLUGIN_CONFIG_DIR/config.json` is optional. Each key maps to a `boat new` flag:

```json
{ "type": "default", "ttl": 28800, "from": "my-agent-stack", "environment": "work" }
```

- `ttl` counts from create or resume, **not from idle time**. Boat's default is 1 hour, so an open shell is cut off after an hour. It is also passed to `boat resume`.
- `from` is a named snapshot (`boat snapshot <id> <name>`). It is Boat's equivalent of an E2B template: set up a sandbox once with your agents, MCP config and toolchains, snapshot it, and every new box starts from it.
- `environment` is a Boat environment (`boat env …`) that holds secrets and env vars. Use it instead of putting keys in this file.

Agent logins: sign in with Claude Pro/Max or ChatGPT on the Boat dashboard's Agents page. Boat refreshes those tokens on every sandbox start, which replaces the whole e2b `auth` subsystem. The images already ship `claude`, `codex`, `opencode` and `pi`.

## How code moves

- **Upload:** `git archive HEAD` is extracted into `~/project` and committed as the baseline. The dirty set (modified and untracked files, respecting `.gitignore`) is unpacked on top and local deletions are replayed, so `git status` on the box matches the laptop. Both tars stream over `boat ssh`. `.git` is never sent.
- **Pull:** the box records its state in `refs/herdr/pulled`. Pull diffs the working tree against that ref (`git diff --binary`, using a scratch index so the agent's staging is untouched), and `git apply` applies the result locally. That is atomic: if local edits conflict, nothing is written and the patch is kept under the state dir for `git apply --3way`. The ref only advances after a successful apply.

## Compared with herdr-e2b-sandbox

| e2b feature | E2B primitive | Boat equivalent | Here |
| - | - | - | - |
| Open box + shell | SDK PTY (`pty.create/connect`), reattach by PID | `boat ssh` (no PTY API) | ✅ via ssh. No reattach: closing the pane kills the shell's processes, but the VM and files persist. Add tmux to your base snapshot for detachable sessions. |
| Templates per harness | E2B public templates | Named snapshots (`--from`) and `boat fork` | ✅ `from` |
| Upload dirty worktree | `files.write` per file + tarball | tar over `boat ssh` (or upload URLs) | ✅ |
| Pull | `files.read` per file, clobber guard | `git diff` over ssh → `git apply` | ✅ (applies deletions too, atomically) |
| Pause / resume | `Sandbox.pause`, auto-resume on connect | `boat stop` / `boat resume` (free while stopped, snapshot every minute) | ✅ resume is automatic on open |
| Kill | `Sandbox.kill` | `boat delete --yes` (irreversible) | ⚠️ intentionally not wired; teardown stops instead |
| Teardown on `worktree.removed` | kill | stop | ✅ |
| Lifecycle timeout | `timeoutMs` + auto-pause | `--ttl` / `boat extend`, auto-stop | ✅ `ttl` |
| Region | `us` / `eu` domains | EU only (DE/FI/FR) | n/a |
| Sync worktree → box | re-upload | same mechanism | ❌ not yet |
| Headless `run` / `exec` | `commands.run` | `boat exec` (600 s sync cap, `--detach`) or `boat prompt` | ❌ not yet |
| Fleet (N agents, 1 task) | N sandboxes + herdr worktrees | `boat fork` of a seeded box, or parallel `boat prompt` conversations in one box | ❌ not yet. Boat makes this cheaper: seed once, fork N. |
| Bench / grading | `exec` in every box | `boat exec` | ❌ not yet |
| Harness auth (OAuth, setup-token, borrowed sessions) | env at create | Dashboard sign-in, `boat ai` profiles, `-e`, environments | ✅ delegated to Boat |
| Model / effort pinning | env + config files | `boat prompt --model --reasoning-effort` | ❌ not needed for interactive shells |
| Dashboard TUI, popup, pickers | Rust TUI over local records | `boat list` | ❌ not yet |
| Preview URL | `getHost(port)` | `boat host <id> <port>` | ❌ run it from the box shell |
| Metadata on sandbox | `metadata` | none (display name via API only) | local records only, as in e2b |

Boat-only features worth using later: Docker and systemd inside the box, `boat desktop`, `boat forward` (including reverse), webhooks, and the integrated agents (`boat prompt`, `boat events`, `boat steer`).

## Not yet verified

This was written against the docs, not a live Boat account. Check these assumptions on first run:

- `boat info --json` returns `state` at the top level or under `sandbox`.
- `boat ssh <id> -- cmd` passes binary stdin and stdout through untouched.
- An interactive `boat ssh` login shell sources `~/.bashrc`.
- `boat` is on `PATH` for herdr-launched processes.

A `boat new` interrupted before its `ready` event leaves an untracked sandbox. It auto-stops at its TTL; find it with `boat list`.

`npm test` runs the upload and pull round trip against a fake `boat` that runs "remote" commands in a temp home.
