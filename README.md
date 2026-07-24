# pi-agent-view

A supervisor-backed multi-session agent view for [Pi](https://github.com/earendil-works/pi-mono).

Agent mode is opt-in. Installing the package does not alter normal Pi prompts, tools, or session behavior.

## Install

```bash
pi install git:github.com/matisfogel99/pi-agent-view
```

Enable agent mode for one client at startup:

```bash
pi --agent-mode
```

Or control it at runtime (including while the foreground agent is working):

```text
/agent-mode on
/agent-mode status
/agent-mode off
```

`/threads` opens the full-screen cross-project dashboard immediately, including while the foreground agent is streaming. Threads are grouped by canonical Git root or working directory and update live without losing the selected thread.

Dashboard controls:

- `↑`/`↓` or `j`/`k`: select a thread
- `Space`: preview live activity, recent output, failures, or an outstanding extension UI request
- `Enter`: attach to the selected thread's bounded, live transcript
- `n`: create and optionally name a persisted RPC thread in the selected project
- `a`: adopt an existing persisted Pi session (duplicate ownership is rejected)
- `x` / `R`: stop or resume a thread without deleting its transcript
- `d`: delete a stopped thread after confirmation; adopted or otherwise unsafe data is reported and preserved
- `/`: search names, projects, activity, and bounded transcript metadata
- `g` / `s`: toggle attention grouping or sorting
- `h`/`l` or `←`/`→`: collapse or expand a project
- `q` or Escape: close the dashboard

From preview, `r` replies to a ready thread or answers its outstanding select, confirm, input, or editor request. Failed delivery restores the user's text to Pi's editor. `Enter` attaches, and `a` aborts only that worker.

The takeover view reads durable session entries through stable cursors and retains at most 200 entries in client memory. Use `p` for a normal prompt, `s` to steer a running worker, `f` to queue a follow-up, `a` to abort that worker, arrows or `j`/`k` to scroll, `End` to follow the live tail, and `q` or Escape to detach without stopping it.

Grouping, sorting, and project expansion choices remain in place when the dashboard is reopened in the current Pi client.

Turning agent mode off, closing the view, or exiting the foreground Pi client only disconnects that client. It does not stop supervised workers. A later `pi --agent-mode` reconnects to the same user-local supervisor and registry.

## Local state

The supervisor stores its Unix socket, restrictive-permission registry, and worker session directories under:

```text
~/.pi/agent/pi-agent-view/
```

The supervisor starts automatically when agent mode first needs it. After an unclean supervisor restart, records whose live RPC connection cannot be proven are marked failed rather than incorrectly shown as working; their persisted session path remains available for recovery. Supervisor protocol version 3 adds interactive delivery, outstanding UI requests, and cursor-based transcript retrieval, and rejects incompatible clients clearly.

## Development

```bash
npm install
npm run check
npm test
```

Tests launch the real supervisor and persistence boundary with a deterministic fake JSONL Pi RPC executable. They require no network access, provider credentials, or user session directory.

## License

MIT
