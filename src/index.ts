import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { DashboardController } from "./dashboard.ts";
import type {
  AdoptThreadInput,
  DeleteThreadResult,
  LaunchThreadInput,
  SupervisorSnapshot,
  ThreadMessageMode,
  ThreadSnapshot,
  TranscriptPage,
  UiResponseInput,
} from "./protocol.ts";
import { SupervisorClient } from "./supervisor-client.ts";
import { TranscriptController } from "./transcript.ts";

const STATUS_KEY = "agent-view";
type ViewAction =
  | { type: "launch"; cwd: string }
  | { type: "adopt" }
  | { type: "stop"; id: string }
  | { type: "resume"; id: string }
  | { type: "delete"; id: string }
  | { type: "search"; query: string }
  | { type: "preview"; id: string }
  | { type: "attach"; id: string }
  | { type: "close" };

export interface AgentViewSupervisor {
  connect(): Promise<SupervisorSnapshot>;
  disconnect(): void;
  onSnapshot(listener: (snapshot: SupervisorSnapshot) => void): () => void;
  snapshot(): Promise<SupervisorSnapshot>;
  launch(input: LaunchThreadInput): Promise<ThreadSnapshot>;
  adopt(input: AdoptThreadInput): Promise<ThreadSnapshot>;
  stop(id: string): Promise<ThreadSnapshot>;
  resume(id: string): Promise<ThreadSnapshot>;
  delete(id: string, confirmed: boolean): Promise<DeleteThreadResult>;
  sendMessage(id: string, mode: ThreadMessageMode, message: string): Promise<ThreadSnapshot>;
  answer(id: string, response: UiResponseInput): Promise<ThreadSnapshot>;
  abort(id: string): Promise<ThreadSnapshot>;
  transcript(id: string, cursor?: string, limit?: number, before?: string): Promise<TranscriptPage>;
}

type ClientFactory = () => AgentViewSupervisor;

export function createAgentViewExtension(clientFactory: ClientFactory = () => new SupervisorClient()) {
  return function agentView(pi: ExtensionAPI): void {
    pi.registerFlag("agent-mode", {
      description: "Enable the supervisor-backed agent view for this Pi client",
      type: "boolean",
      default: false,
    });

    // Pi applies extension CLI flag values after loading extension factories.
    // Read the startup flag at session_start, not during registration.
    let enabled = false;
    let client: AgentViewSupervisor | undefined;
    let unsubscribe: (() => void) | undefined;
    let latest: SupervisorSnapshot | undefined;
    let dashboard: DashboardController | undefined;

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
      dashboard ??= new DashboardController(snapshot);
      dashboard.applySnapshot(snapshot);
      unsubscribe = next.onSnapshot((value) => {
        latest = value;
        dashboard?.applySnapshot(value);
        const active = value.threads.filter((thread) => thread.state === "starting" || thread.state === "working").length;
        const waiting = value.threads.filter((thread) => thread.state === "needs-input" || thread.state === "failed").length;
        const suffix = waiting ? `, ${waiting} attention` : "";
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(waiting ? "warning" : "accent", `agents: ${active}${suffix}`));
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
      description: "Open the cross-project agent thread dashboard",
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
          ctx.ui.notify(formatSnapshot(await supervisor.snapshot()), "info");
          return;
        }

        dashboard ??= new DashboardController(latest ?? await supervisor.snapshot());
        while (enabled) {
          dashboard.applySnapshot(latest ?? await supervisor.snapshot());
          const action = await openDashboard(ctx, supervisor, dashboard);
          if (!action || action.type === "close") break;
          if (action.type === "search") {
            const query = await ctx.ui.input("Search threads", action.query || "name, project, or transcript metadata");
            if (query !== undefined) dashboard.setSearch(query);
            continue;
          }
          if (action.type === "preview") {
            const attach = await previewThread(ctx, supervisor, action.id);
            if (attach) await takeoverThread(ctx, supervisor, action.id);
            continue;
          }
          if (action.type === "attach") {
            await takeoverThread(ctx, supervisor, action.id);
            continue;
          }
          if (action.type === "stop") {
            await supervisor.stop(action.id).catch((cause) => ctx.ui.notify(`Could not stop thread: ${errorMessage(cause)}`, "error"));
            continue;
          }
          if (action.type === "resume") {
            await supervisor.resume(action.id).catch((cause) => ctx.ui.notify(`Could not resume thread: ${errorMessage(cause)}`, "error"));
            continue;
          }
          if (action.type === "delete") {
            const thread = dashboard.snapshot().threads.find((candidate) => candidate.id === action.id);
            if (!thread || thread.state !== "stopped") {
              ctx.ui.notify("Only stopped threads can be deleted", "warning");
              continue;
            }
            const confirmed = await ctx.ui.confirm("Delete stopped thread?", `Remove “${thread.name}” from agent view? Managed transcript data will be removed when safe; adopted sessions are preserved.`);
            if (!confirmed) continue;
            try {
              const result = await supervisor.delete(action.id, true);
              reportDeletion(ctx, result);
            } catch (cause) {
              ctx.ui.notify(`Could not delete thread: ${errorMessage(cause)}`, "error");
            }
            continue;
          }
          if (action.type === "adopt") {
            await adoptSession(ctx, supervisor);
            continue;
          }

          const cwdInput = await ctx.ui.input("Project working directory", action.cwd);
          if (cwdInput === undefined) continue;
          const name = await ctx.ui.input("Thread name", "optional");
          if (name === undefined) continue;
          const prompt = await ctx.ui.input("Initial prompt", "optional; leave blank to launch idle");
          if (prompt === undefined) continue;
          const isolationChoice = await ctx.ui.select("Checkout isolation", [
            "Isolated Git worktree (recommended)",
            "Shared checkout (unsafe for concurrent edits)",
          ]);
          if (!isolationChoice) continue;
          const projectTrusted = await ctx.ui.confirm(
            "Load project-local Pi resources?",
            "Approve this worker to load project settings, extensions, skills, prompts, and themes? Approval applies only to this worker launch.",
          );
          try {
            await supervisor.launch({
              cwd: cwdInput.trim() || action.cwd,
              name: name.trim() || undefined,
              prompt: prompt.trim() || undefined,
              isolation: isolationChoice.startsWith("Shared") ? "shared" : "required",
              projectTrusted,
            });
          } catch (cause) {
            ctx.ui.notify(`Could not launch thread: ${errorMessage(cause)}`, "error");
          }
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      if (Boolean(pi.getFlag("agent-mode"))) enabled = true;
      if (!enabled) return;
      try {
        await connect(ctx);
      } catch (cause) {
        enabled = false;
        clearConnection();
        ctx.ui.notify(`Could not enable startup agent mode: ${errorMessage(cause)}`, "error");
      }
    });

    pi.on("session_shutdown", async () => clearConnection());
  };
}

export default createAgentViewExtension();

async function openDashboard(ctx: ExtensionContext, supervisor: AgentViewSupervisor, dashboard: DashboardController): Promise<ViewAction | undefined> {
  return await ctx.ui.custom<ViewAction>((tui, theme, _keybindings, done) => {
    const off = supervisor.onSnapshot((snapshot) => {
      dashboard.applySnapshot(snapshot);
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
        const grouping = dashboard.preferences.grouping === "project" ? "project" : "attention";
        const search = dashboard.searchQuery() ? `  filter: ${dashboard.searchQuery()}` : "";
        const lines = [
          theme.fg("accent", theme.bold("Pi Agent View")) + theme.fg("dim", `  ${grouping} / ${dashboard.preferences.sort}${search}`),
          theme.fg("dim", "Space preview  Enter attach  n new  a adopt  x stop  R resume  d delete  / search  g group  q close"),
          "",
        ];
        const groups = dashboard.groups();
        if (groups.length === 0) lines.push(theme.fg("muted", dashboard.searchQuery() ? "No threads match the current search." : "No supervised threads. Press n to create one or a to adopt a session."));
        for (const group of groups) {
          const disclosure = dashboard.preferences.grouping === "project" ? (group.expanded ? "▾" : "▸") : "•";
          lines.push(theme.fg("accent", `${disclosure} ${group.label}`) + theme.fg("dim", ` (${group.threads.length})`));
          if (!group.expanded) continue;
          for (const thread of group.threads) {
            const selected = thread.id === dashboard.selectedThreadId();
            const marker = selected ? theme.fg("accent", ">") : " ";
            const state = thread.state === "needs-input" ? "needs input" : thread.state;
            const project = basename(thread.project) || thread.project;
            const checkout = checkoutLabel(thread);
            const row = `${marker} ${theme.fg(stateColor(thread), state.padEnd(11))} ${theme.bold(thread.name)}  ${thread.activity ?? thread.lastEvent ?? ""}  ${theme.fg("dim", `${project} · ${checkout} · ${relativeTime(thread.updatedAt)}`)}`;
            lines.push(`  ${row}`);
            if (selected) {
              lines.push(theme.fg("dim", `      checkout: ${thread.checkout.path}  cwd: ${thread.cwd}`));
              if (thread.error) lines.push(theme.fg("error", `      ${thread.error}`));
              if (thread.checkout.warning) lines.push(theme.fg("warning", `      ${thread.checkout.warning}`));
            }
          }
        }
        return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
      },
      invalidate() {},
      dispose() { off(); },
      handleInput(data: string): void {
        const selected = dashboard.selected();
        if (matchesKey(data, Key.up) || data === "k") dashboard.move(-1);
        else if (matchesKey(data, Key.down) || data === "j") dashboard.move(1);
        else if (matchesKey(data, Key.left) || data === "h" || matchesKey(data, Key.right) || data === "l") dashboard.toggleSelectedProject();
        else if (data === "g") dashboard.toggleGrouping();
        else if (data === "s") dashboard.toggleSort();
        else if (data === "/") finish({ type: "search", query: dashboard.searchQuery() });
        else if ((matchesKey(data, Key.space)) && selected) finish({ type: "preview", id: selected.id });
        else if (matchesKey(data, Key.enter) && selected) finish({ type: "attach", id: selected.id });
        else if (data === "n") finish({ type: "launch", cwd: selected?.cwd ?? ctx.cwd });
        else if (data === "a") finish({ type: "adopt" });
        else if (data === "x" && selected) finish({ type: "stop", id: selected.id });
        else if (data === "R" && selected) finish({ type: "resume", id: selected.id });
        else if (data === "d" && selected) finish({ type: "delete", id: selected.id });
        else if (data === "r") void supervisor.snapshot().catch((cause) => ctx.ui.notify(errorMessage(cause), "error"));
        else if (data === "q" || matchesKey(data, Key.escape)) finish({ type: "close" });
        tui.requestRender();
      },
    };
  });
}

async function previewThread(ctx: ExtensionContext, supervisor: AgentViewSupervisor, id: string): Promise<boolean> {
  while (true) {
    const action = await ctx.ui.custom<"back" | "attach" | "reply" | "abort">((tui, theme, _keys, done) => {
      let thread = latestThread(id, dashboardSnapshot(supervisor));
      let finished = false;
      const off = supervisor.onSnapshot((snapshot) => {
        thread = latestThread(id, snapshot);
        tui.requestRender();
      });
      const finish = (value: "back" | "attach" | "reply" | "abort") => {
        if (finished) return;
        finished = true;
        off();
        done(value);
      };
      return {
        render(width: number): string[] {
          if (!thread) return [theme.fg("error", "Thread no longer exists")].map((line) => truncateToWidth(line, Math.max(1, width)));
          const pending = thread.pendingRequest;
          const content = thread.error
            ? theme.fg("error", thread.error)
            : pending
              ? [pending.title, pending.message, pending.options?.length ? `Choices: ${pending.options.join(" · ")}` : undefined].filter(Boolean).join("\n")
              : thread.recentOutput || thread.activity || "No output yet";
          const lines = [
            theme.fg("accent", theme.bold(thread.name)) + theme.fg("dim", `  ${thread.state}`),
            theme.fg("dim", `${thread.project}  ·  ${checkoutLabel(thread)}: ${thread.checkout.path}`),
            "",
            ...content.split("\n"),
            "",
            theme.fg("dim", "r reply  Enter attach  a abort worker  Space/Esc back"),
          ];
          return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
        },
        invalidate() {},
        dispose() { off(); },
        handleInput(data: string) {
          if (data === "r") finish("reply");
          else if (data === "a") finish("abort");
          else if (matchesKey(data, Key.enter)) finish("attach");
          else if (matchesKey(data, Key.space) || matchesKey(data, Key.escape) || data === "q") finish("back");
          tui.requestRender();
        },
      };
    });
    if (action === "back" || !action) return false;
    if (action === "attach") return true;
    if (action === "abort") {
      await supervisor.abort(id).catch((cause) => ctx.ui.notify(`Could not abort worker: ${errorMessage(cause)}`, "error"));
      continue;
    }
    const snapshot = await supervisor.snapshot();
    const thread = snapshot.threads.find((candidate) => candidate.id === id);
    if (!thread) return false;
    if (thread.state === "needs-input" && thread.pendingRequest) await answerPendingRequest(ctx, supervisor, thread);
    else if (thread.state === "ready") await collectAndDeliver(ctx, supervisor, id, "prompt", "Reply to thread");
    else ctx.ui.notify("Replies are available when the thread is ready or waiting for input", "warning");
  }
}

async function takeoverThread(ctx: ExtensionContext, supervisor: AgentViewSupervisor, id: string): Promise<void> {
  const transcript = new TranscriptController(200);
  try { transcript.applyPage(await supervisor.transcript(id, undefined, 100)); }
  catch (cause) { ctx.ui.notify(`Could not load transcript: ${errorMessage(cause)}`, "error"); return; }

  while (true) {
    const action = await ctx.ui.custom<"detach" | "prompt" | "steer" | "followUp" | "abort">((tui, theme, _keys, done) => {
      let thread: ThreadSnapshot | undefined;
      let finished = false;
      let olderLoading = false;
      let refreshing = false;
      let refreshRequested = false;
      const refresh = () => {
        refreshRequested = true;
        if (refreshing) return;
        refreshing = true;
        void (async () => {
          while (refreshRequested && !finished) {
            refreshRequested = false;
            const page = await supervisor.transcript(id, transcript.cursor(), 100);
            transcript.applyPage(page);
            if (!finished) tui.requestRender();
          }
        })().catch((cause) => {
          if (!finished) ctx.ui.notify(`Transcript update failed: ${errorMessage(cause)}`, "error");
        }).finally(() => {
          refreshing = false;
          if (refreshRequested && !finished) refresh();
        });
      };
      const loadOlder = () => {
        if (olderLoading || !transcript.shouldLoadOlder() || !transcript.oldestCursor()) return;
        olderLoading = true;
        void supervisor.transcript(id, undefined, 100, transcript.oldestCursor()).then((page) => {
          transcript.prependPage(page);
          if (!finished) tui.requestRender();
        }).catch((cause) => {
          if (!finished) ctx.ui.notify(`Could not load older transcript entries: ${errorMessage(cause)}`, "error");
        }).finally(() => { olderLoading = false; });
      };
      const off = supervisor.onSnapshot((snapshot) => {
        thread = snapshot.threads.find((candidate) => candidate.id === id);
        refresh();
        tui.requestRender();
      });
      const finish = (value: "detach" | "prompt" | "steer" | "followUp" | "abort") => {
        if (finished) return;
        finished = true;
        off();
        done(value);
      };
      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          const rows = Math.max(4, tui.terminal.rows - 5);
          const header = theme.fg("accent", theme.bold(thread?.name ?? "Thread")) + theme.fg("dim", `  ${thread?.state ?? "loading"}`);
          const body = transcript.render(safeWidth, rows);
          if (thread?.state === "working" && thread.recentOutput) body.push(...thread.recentOutput.split("\n").slice(-3).map((line) => theme.fg("muted", `stream> ${line}`)));
          const help = theme.fg("dim", "p prompt  s steer  f follow-up  a abort  ↑/↓ scroll  End latest  q detach");
          return [header, ...body.slice(-rows), help].map((line) => truncateToWidth(line, safeWidth));
        },
        invalidate() {},
        dispose() { off(); },
        handleInput(data: string) {
          if (data === "p") finish("prompt");
          else if (data === "s") finish("steer");
          else if (data === "f") finish("followUp");
          else if (data === "a") finish("abort");
          else if (matchesKey(data, Key.up) || data === "k") { transcript.scroll(1); loadOlder(); }
          else if (matchesKey(data, Key.down) || data === "j") transcript.scroll(-1);
          else if (matchesKey(data, Key.end)) transcript.followLatest();
          else if (data === "q" || matchesKey(data, Key.escape)) finish("detach");
          tui.requestRender();
        },
      };
    });
    if (!action || action === "detach") return;
    if (action === "abort") {
      await supervisor.abort(id).catch((cause) => ctx.ui.notify(`Could not abort worker: ${errorMessage(cause)}`, "error"));
      continue;
    }
    await collectAndDeliver(ctx, supervisor, id, action, action === "followUp" ? "Queue follow-up" : action === "steer" ? "Steer running thread" : "Prompt thread");
  }
}

async function answerPendingRequest(ctx: ExtensionContext, supervisor: AgentViewSupervisor, thread: ThreadSnapshot): Promise<void> {
  const request = thread.pendingRequest!;
  let response: UiResponseInput | undefined;
  let retainedInput = "";
  if (request.method === "select") {
    const value = await ctx.ui.select(request.title ?? "Choose an option", request.options ?? []);
    if (value === undefined) return;
    retainedInput = value;
    response = { requestId: request.id, value };
  } else if (request.method === "confirm") {
    const confirmed = await ctx.ui.confirm(request.title ?? "Confirm", request.message ?? "Continue?");
    retainedInput = confirmed ? "Yes" : "No";
    response = { requestId: request.id, confirmed };
  } else if (request.method === "editor") {
    const value = await ctx.ui.editor(request.title ?? "Reply", request.prefill ?? "");
    if (value === undefined) return;
    retainedInput = value;
    response = { requestId: request.id, value };
  } else {
    const value = await ctx.ui.input(request.title ?? "Reply", request.placeholder ?? request.message ?? "");
    if (value === undefined) return;
    retainedInput = value;
    response = { requestId: request.id, value };
  }
  try { await supervisor.answer(thread.id, response); }
  catch (cause) { retainFailedInput(ctx, cause, retainedInput); }
}

async function collectAndDeliver(ctx: ExtensionContext, supervisor: AgentViewSupervisor, id: string, mode: ThreadMessageMode, title: string): Promise<void> {
  const value = await ctx.ui.input(title, "Type a message");
  if (value === undefined || !value.trim()) return;
  try { await supervisor.sendMessage(id, mode, value); }
  catch (cause) { retainFailedInput(ctx, cause, value); }
}

function retainFailedInput(ctx: ExtensionContext, cause: unknown, value: string): void {
  ctx.ui.setEditorText(value);
  ctx.ui.notify(`Input was not delivered and has been restored to the editor: ${errorMessage(cause)}`, "error");
}

function latestThread(id: string, snapshot: SupervisorSnapshot | undefined): ThreadSnapshot | undefined {
  return snapshot?.threads.find((thread) => thread.id === id);
}

function dashboardSnapshot(supervisor: AgentViewSupervisor): SupervisorSnapshot | undefined {
  // onSnapshot immediately supplies the current snapshot for real and in-memory adapters.
  let current: SupervisorSnapshot | undefined;
  const off = supervisor.onSnapshot((snapshot) => { current = snapshot; });
  off();
  return current;
}

async function adoptSession(ctx: ExtensionContext, supervisor: AgentViewSupervisor): Promise<void> {
  try {
    const sessions = await SessionManager.listAll();
    if (sessions.length === 0) {
      ctx.ui.notify("No persisted Pi sessions were found", "info");
      return;
    }
    const labels = sessions.map((session, index) => `${index + 1}. ${session.name || session.firstMessage || "Unnamed session"} — ${session.cwd} (${session.modified.toLocaleString()})`);
    const choice = await ctx.ui.select("Adopt persisted Pi session", labels);
    if (!choice) return;
    const index = labels.indexOf(choice);
    const session = sessions[index];
    if (!session) return;
    const name = await ctx.ui.input("Thread name", session.name || session.firstMessage.slice(0, 80) || "optional");
    if (name === undefined) return;
    const allowSharedCheckout = await ctx.ui.confirm(
      "Use the session's saved checkout?",
      "Adopted sessions cannot be moved transparently. If this is a Git session, it will share its saved checkout with other processes. Continue only if concurrent edits are safe.",
    );
    if (!allowSharedCheckout) return;
    const projectTrusted = await ctx.ui.confirm(
      "Load project-local Pi resources?",
      "Approve this adopted worker to load project settings, extensions, skills, prompts, and themes? Approval applies only to this worker launch.",
    );
    await supervisor.adopt({ sessionFile: session.path, name: name.trim() || undefined, allowSharedCheckout, projectTrusted });
  } catch (cause) {
    ctx.ui.notify(`Could not adopt session: ${errorMessage(cause)}`, "error");
  }
}

function reportDeletion(ctx: ExtensionContext, result: DeleteThreadResult): void {
  if (result.warnings.length || result.preservedPaths.length) {
    const details = [...result.warnings, ...result.preservedPaths.map((path) => `Preserved: ${path}`)].join("\n");
    ctx.ui.notify(`Thread removed from agent view.\n${details}`, "warning");
  } else {
    ctx.ui.notify(result.transcriptDeleted ? "Thread and managed transcript deleted" : "Thread deleted", "info");
  }
}

function stateColor(thread: ThreadSnapshot): "error" | "warning" | "success" | "muted" {
  if (thread.state === "failed") return "error";
  if (thread.state === "working" || thread.state === "starting" || thread.state === "needs-input") return "warning";
  if (thread.state === "ready") return "success";
  return "muted";
}

function relativeTime(timestamp: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

function formatSnapshot(snapshot: SupervisorSnapshot): string {
  if (snapshot.threads.length === 0) return "No supervised threads";
  return snapshot.threads.map((thread) => `${thread.state}: ${thread.name} — ${thread.activity ?? thread.cwd} (${thread.project}; ${checkoutLabel(thread)} ${thread.checkout.path})`).join("\n");
}

function checkoutLabel(thread: ThreadSnapshot): string {
  if (thread.checkout.mode === "worktree") return `worktree ${thread.checkout.branch ?? "isolated"}`;
  if (thread.checkout.mode === "shared") return "shared checkout";
  return "directory";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
