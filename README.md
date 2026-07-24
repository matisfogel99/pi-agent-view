# pi-agent-view

A supervisor-backed multi-session agent view for [Pi](https://github.com/earendil-works/pi-mono).

Agent mode is opt-in. Installing the package does not alter normal Pi prompts, tools, session behavior, or start a background process.

## Installation

Install through Pi's package manager:

```bash
pi install git:github.com/matisfogel99/pi-agent-view
```

Review package source before installation: Pi extensions execute with the installing user's permissions. Update or remove it through normal Pi workflows:

```bash
pi update --extension git:github.com/matisfogel99/pi-agent-view
pi remove git:github.com/matisfogel99/pi-agent-view
```

## Agent mode

Enable agent mode for one client at startup:

```bash
pi --agent-mode
```

Or control it at runtime, including while the foreground agent is working:

```text
/agent-mode on
/agent-mode status
/agent-mode off
```

`/threads` explains how to opt in when mode is off. Turning mode off, closing the dashboard, or exiting foreground Pi disconnects only that client; it never silently stops supervised workers. A later Pi process can reconnect to the same user-local supervisor.

## Dashboard and thread controls

`/threads` opens the full-screen cross-project dashboard immediately, including while the foreground agent is streaming. Threads are grouped by canonical Git root or working directory and update live without losing selection.

- `↑`/`↓` or `j`/`k`: select a thread
- `Space`: preview live activity, recent output, failures, or an outstanding extension UI request
- `Enter`: attach to the bounded live transcript
- `n`: choose checkout isolation, then create and enter a persisted RPC thread in Pi's current working directory
- `a`: adopt an existing persisted Pi session (duplicate ownership is rejected)
- `x` / `R`: stop or resume without deleting the transcript or checkout
- `d`: delete a stopped thread after confirmation
- `/`: search names, projects, activity, and bounded transcript metadata
- `g` / `s`: toggle attention grouping or sorting
- `h`/`l` or `←`/`→`: collapse or expand a project
- `q` or Escape: close the dashboard

Each selected row and preview reports the actual checkout path and whether it is an isolated worktree, an explicitly shared checkout, or a non-Git directory.

From preview, `r` replies to a ready thread or answers its outstanding select, confirm, input, or editor request. Failed delivery restores the user's text to Pi's editor. `Enter` attaches and `a` aborts only that worker.

The takeover view reads durable session entries through stable cursors and retains at most 200 entries in client memory. It includes a Pi-style editor: Enter sends a prompt or steers a running worker, Shift+Enter inserts a newline, Alt+Enter queues a follow-up, Escape aborts the worker, Page Up/Page Down scroll, and Ctrl+D detaches without stopping it. After the first prompt, the agent generates a concise thread name.

## Isolation and project trust

New threads in Git repositories use a managed worktree and dedicated `pi-agent-view/<thread-id>` branch by default. The worker starts only after `git worktree add` succeeds. If isolation fails, launch is blocked with a diagnostic; sharing the selected checkout requires choosing the explicitly unsafe **Shared checkout** option. Non-Git directories use their selected canonical directory. Adopted Git sessions cannot be moved transparently from their persisted cwd, so adoption requires a separate explicit confirmation that the saved checkout may be shared.

Stopping preserves the checkout. Confirmed deletion removes a managed worktree only when it is present, clean, and still at its launch commit. Dirty worktrees, branches with later commits that may be unpushed, shared checkouts, and externally removed worktrees are preserved or reported with recovery details. Transcript deletion and checkout cleanup are reported separately.

New threads inherit Pi's current working directory and load its project-local settings, extensions, skills, prompts, and themes through a one-run `--approve` decision. Checkout isolation remains the single explicit launch choice. Approval is scoped to the selected worker. Adopted sessions retain an explicit trust confirmation because they may originate elsewhere.

Git worktrees isolate repository files, not credentials, processes, network access, or non-repository paths. Use an OS sandbox, container, or VM for untrusted or unattended code.

## Worker lifetime and recovery

The supervisor owns workers independently of dashboard clients. It serializes lifecycle/input operations, correlates RPC commands, and broadcasts snapshots to any number of connected Pi clients. Stopping a worker preserves its registry record and Pi session; resume starts a new RPC process from that session.

After an unclean supervisor exit, stale lock/socket state is reconciled. Orphan worker process groups are terminated, records that cannot prove a live RPC connection are marked failed, and persisted sessions remain resumable. Graceful supervisor shutdown terminates workers before releasing the registry lock and records a recovery diagnostic.

Malformed or oversized JSONL, partial writes, delayed RPC responses, unexpected events, and worker crashes are bounded and isolated to the affected request or worker. Recent output, search metadata, stderr, transcript entries, transcript pages, and client-side transcript retention all have fixed limits.

## Local state and security

The default state root is:

```text
~/.pi/agent/pi-agent-view/
```

It contains `supervisor.sock`, `supervisor.lock`, `registry.json`, `supervisor.log`, managed session directories, and managed worktrees. Directories are forced to mode `0700`; the socket, lock, registry, and log are mode `0600`. The supervisor rejects state files/directories not owned by the current user and does not provide remote or multi-user IPC.

Supervisor protocol version 5 adds AI-generated thread names and the attached Pi-style editor while retaining checkout/isolation metadata, scoped project trust, request replay protection, and hardened lifecycle behavior. Incompatible clients fail clearly rather than mutating state.

## Troubleshooting

- **Agent mode is off:** run `/agent-mode on` or restart with `pi --agent-mode`.
- **Isolation failed:** resolve the reported Git/worktree problem. Choose a shared checkout only when concurrent edits are known to be safe.
- **Thread is failed after restart:** inspect its error in preview, then use `R` to resume from the persisted session.
- **Deletion preserved a path:** inspect and commit, push, copy, or discard the reported worktree/session yourself before removing it with Git.
- **Supervisor will not start:** inspect `~/.pi/agent/pi-agent-view/supervisor.log`. Active owner PIDs are reported; dead stale locks are removed automatically.
- **Protocol mismatch:** stop old clients/supervisor processes and update the package so client and daemon versions match.
- **Permission error:** ensure the state root and files are owned by your user. Do not place supervisor state in a shared directory.

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

Tests use temporary Pi config, session, supervisor, and Git directories; launch the real supervisor against a deterministic fake JSONL worker; run Pi package-install smoke coverage in offline mode; and require no network calls, provider credentials, or access to the user's real Pi session directory.

## License

MIT
