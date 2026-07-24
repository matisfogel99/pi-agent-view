import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SupervisorSnapshot, ThreadSnapshot } from "./protocol.ts";
import { SupervisorClient } from "./supervisor-client.ts";

const STATUS_KEY = "agent-view";
type ViewAction = { type: "launch" } | { type: "stop"; id: string } | { type: "close" };
export interface AgentViewSupervisor {
  connect(): Promise<SupervisorSnapshot>;
  disconnect(): void;
  onSnapshot(listener: (snapshot: SupervisorSnapshot) => void): () => void;
  snapshot(): Promise<SupervisorSnapshot>;
  launch(input: { cwd: string; name?: string; prompt?: string }): Promise<ThreadSnapshot>;
  stop(id: string): Promise<ThreadSnapshot>;
}

type ClientFactory = () => AgentViewSupervisor;

export function createAgentViewExtension(clientFactory: ClientFactory = () => new SupervisorClient()) {
  return function agentView(pi: ExtensionAPI): void {
    pi.registerFlag("agent-mode", {
      description: "Enable the supervisor-backed agent view for this Pi client",
      type: "boolean",
      default: false,
    });

    let enabled = Boolean(pi.getFlag("agent-mode"));
    let client: AgentViewSupervisor | undefined;
    let unsubscribe: (() => void) | undefined;
    let latest: SupervisorSnapshot | undefined;

    const clearConnection = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      client?.disconnect();
      client = undefined;
      latest = undefined;
    };

    const connect = async (ctx: ExtensionContext) => {
      if (client) return client;
      const next = clientFactory();
      const snapshot = await next.connect();
      client = next;
      latest = snapshot;
      unsubscribe = next.onSnapshot((value) => {
        latest = value;
        const active = value.threads.filter((thread) => thread.state === "starting" || thread.state === "working").length;
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `agents: ${active}`));
      });
      return next;
    };

    pi.registerCommand("agent-mode", {
      description: "Enable, disable, or inspect agent mode (on|off|status)",
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase() || "status";
        if (action === "on") {
          if (enabled && client) {
            ctx.ui.notify("Agent mode is already on", "info");
            return;
          }
          enabled = true;
          try {
            await connect(ctx);
            ctx.ui.notify("Agent mode enabled", "info");
          } catch (cause) {
            enabled = false;
            clearConnection();
            ctx.ui.notify(`Could not enable agent mode: ${errorMessage(cause)}`, "error");
          }
        } else if (action === "off") {
          enabled = false;
          clearConnection();
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify("Agent mode disabled; supervised workers were left running", "info");
        } else if (action === "status") {
          ctx.ui.notify(`Agent mode is ${enabled ? "on" : "off"}`, "info");
        } else {
          ctx.ui.notify("Usage: /agent-mode on|off|status", "warning");
        }
      },
    });

    pi.registerCommand("threads", {
      description: "Open the agent thread view",
      handler: async (_args, ctx) => {
        if (!enabled) {
          ctx.ui.notify("Agent mode is off. Run /agent-mode on or start Pi with --agent-mode.", "info");
          return;
        }

        let supervisor: AgentViewSupervisor;
        try {
          supervisor = await connect(ctx);
        } catch (cause) {
          ctx.ui.notify(`Could not connect to supervisor: ${errorMessage(cause)}`, "error");
          return;
        }

        if (ctx.mode !== "tui") {
          const snapshot = await supervisor.snapshot();
          ctx.ui.notify(formatSnapshot(snapshot), "info");
          return;
        }

        while (enabled) {
          const snapshot = latest ?? await supervisor.snapshot();
          const action = await ctx.ui.custom<ViewAction>((tui, theme, _keybindings, done) => {
            let selectedId = snapshot.threads[0]?.id;
            let current = snapshot;
            const off = supervisor.onSnapshot((next) => {
              current = next;
              if (selectedId && !next.threads.some((thread) => thread.id === selectedId)) selectedId = next.threads[0]?.id;
              tui.requestRender();
            });
            let finished = false;
            const finish = (value: ViewAction) => {
              if (finished) return;
              finished = true;
              off();
              done(value);
            };
            return {
              render(width: number): string[] {
                const lines = [theme.fg("accent", theme.bold("Pi Agent View")), theme.fg("dim", "n new  x stop  ↑/↓ select  r refresh  q/esc close"), ""];
                if (current.threads.length === 0) lines.push(theme.fg("muted", "No supervised threads. Press n to launch one."));
                for (const thread of current.threads) {
                  const selected = thread.id === selectedId;
                  const marker = selected ? theme.fg("accent", ">") : " ";
                  const stateColor = thread.state === "failed" ? "error" : thread.state === "working" || thread.state === "starting" ? "warning" : thread.state === "ready" ? "success" : "muted";
                  lines.push(`${marker} ${theme.fg(stateColor, thread.state.padEnd(8))} ${theme.bold(thread.name)}  ${theme.fg("dim", thread.cwd)}`);
                  if (selected && (thread.error || thread.sessionFile)) lines.push(theme.fg(thread.error ? "error" : "dim", `    ${thread.error ?? `session: ${thread.sessionFile}`}`));
                }
                return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
              },
              invalidate() {},
              handleInput(data: string): void {
                const index = Math.max(0, current.threads.findIndex((thread) => thread.id === selectedId));
                if (matchesKey(data, Key.up) || data === "k") selectedId = current.threads[Math.max(0, index - 1)]?.id;
                else if (matchesKey(data, Key.down) || data === "j") selectedId = current.threads[Math.min(current.threads.length - 1, index + 1)]?.id;
                else if (data === "n") finish({ type: "launch" });
                else if (data === "x" && selectedId) finish({ type: "stop", id: selectedId });
                else if (data === "r") void supervisor.snapshot().catch((cause) => ctx.ui.notify(errorMessage(cause), "error"));
                else if (data === "q" || matchesKey(data, Key.escape)) finish({ type: "close" });
                tui.requestRender();
              },
            };
          });

          if (!action || action.type === "close") break;
          if (action.type === "stop") {
            await supervisor.stop(action.id).catch((cause) => ctx.ui.notify(`Could not stop thread: ${errorMessage(cause)}`, "error"));
            continue;
          }
          const cwdInput = await ctx.ui.input("Worker working directory", ctx.cwd);
          if (cwdInput === undefined) continue;
          const name = await ctx.ui.input("Thread name", "optional");
          if (name === undefined) continue;
          const prompt = await ctx.ui.input("Initial prompt", "optional; leave blank to launch idle");
          if (prompt === undefined) continue;
          try {
            await supervisor.launch({ cwd: cwdInput.trim() || ctx.cwd, name: name.trim() || undefined, prompt: prompt.trim() || undefined });
          } catch (cause) {
            ctx.ui.notify(`Could not launch thread: ${errorMessage(cause)}`, "error");
          }
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      if (!enabled) return;
      try {
        await connect(ctx);
      } catch (cause) {
        enabled = false;
        clearConnection();
        ctx.ui.notify(`Could not enable startup agent mode: ${errorMessage(cause)}`, "error");
      }
    });

    pi.on("session_shutdown", async () => {
      clearConnection();
    });
  };
}

export default createAgentViewExtension();

function formatSnapshot(snapshot: SupervisorSnapshot): string {
  if (snapshot.threads.length === 0) return "No supervised threads";
  return snapshot.threads.map((thread: ThreadSnapshot) => `${thread.state}: ${thread.name} (${thread.cwd})`).join("\n");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
