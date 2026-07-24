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

`/threads` opens the minimal full-screen thread view. Press `n` to choose a working directory, name, and optional initial prompt for a persisted Pi RPC worker. Use arrows or `j`/`k` to select a thread, `x` to stop it, and `q` or Escape to close the view.

Turning agent mode off, closing the view, or exiting the foreground Pi client only disconnects that client. It does not stop supervised workers. A later `pi --agent-mode` reconnects to the same user-local supervisor and registry.

## Local state

The supervisor stores its Unix socket, restrictive-permission registry, and worker session directories under:

```text
~/.pi/agent/pi-agent-view/
```

The supervisor starts automatically when agent mode first needs it. After an unclean supervisor restart, records whose live RPC connection cannot be proven are marked failed rather than incorrectly shown as working; their persisted session path remains available for recovery.

## Development

```bash
npm install
npm run check
npm test
```

Tests launch the real supervisor and persistence boundary with a deterministic fake JSONL Pi RPC executable. They require no network access, provider credentials, or user session directory.

## License

MIT
