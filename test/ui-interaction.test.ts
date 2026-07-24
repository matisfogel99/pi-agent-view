import assert from "node:assert/strict";
import test from "node:test";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { createAgentViewExtension, type AgentViewSupervisor } from "../src/index.ts";
import type { SupervisorSnapshot, ThreadMessageMode, ThreadSnapshot } from "../src/protocol.ts";

const baseThread: ThreadSnapshot = {
  id: "thread-1", cwd: "/project", project: "/project", name: "Interactive thread", state: "ready",
  sessionOrigin: "created", sessionFile: "/tmp/session.jsonl",
  checkout: { mode: "directory", path: "/project", managed: false }, projectTrusted: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", recentOutput: "recent result",
};

test("Space preview, input focus handoff, takeover controls, live rendering, and detach work without touching foreground Pi", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  const listeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  let thread = structuredClone(baseThread);
  const deliveries: ThreadMessageMode[] = [];
  const notifications: string[] = [];
  let aborts = 0;
  const snapshot = (): SupervisorSnapshot => ({ protocolVersion: 5, supervisorPid: 1, threads: [structuredClone(thread)] });
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const supervisor: AgentViewSupervisor = {
    async connect() { return snapshot(); }, disconnect() {},
    onSnapshot(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    async snapshot() { return snapshot(); },
    async launch() { throw new Error("unused"); }, async adopt() { throw new Error("unused"); },
    async stop() { throw new Error("unused"); }, async resume() { throw new Error("unused"); }, async delete() { throw new Error("unused"); },
    async sendMessage(_id, mode) {
      deliveries.push(mode);
      if (mode === "followUp") throw new Error("simulated delivery failure");
      thread.state = "working"; emit(); return structuredClone(thread);
    },
    async answer() { throw new Error("unused"); },
    async abort() { aborts++; thread.state = "ready"; emit(); return structuredClone(thread); },
    async transcript(_id, cursor) {
      return cursor ? { entries: [], cursor, hasMore: false } : {
        entries: [{ type: "message", id: "entry-1", message: { role: "assistant", content: "durable transcript" } }],
        startCursor: "entry-1", cursor: "entry-1", hasMore: false,
      };
    },
  };
  const pi = {
    registerFlag() {}, getFlag() { return true; },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) { events.set(name, handler); },
  };
  createAgentViewExtension(() => supervisor)(pi as any);

  const keys = [
    [" "],
    ["r"],
    ["\r"],
    [..."steering reply", "\r"],
    [..."follow-up reply", "\x1b\r"],
    ["\x1b"],
    ["\x15", "\x04"],
    ["q"],
  ];
  const inputs = ["normal reply"];
  let renderRequests = 0;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx = {
    mode: "tui", cwd: "/foreground", isIdle: () => false,
    abort: () => { throw new Error("foreground must not be aborted"); },
    waitForIdle: () => { throw new Error("foreground must not be awaited"); },
    ui: {
      theme,
      notify: (message: string) => { notifications.push(message); }, setStatus: () => undefined,
      setEditorText: () => undefined,
      input: async () => inputs.shift(), editor: async () => undefined, select: async () => undefined, confirm: async () => false,
      custom: async (factory: any) => await new Promise((resolve) => {
        const tui = { terminal: { rows: 18 }, requestRender: () => { renderRequests++; } };
        const keybindings = {
          matches(data: string, id: string) {
            if (id === "tui.input.submit") return matchesKey(data, Key.enter);
            if (id === "app.message.followUp") return matchesKey(data, Key.alt("enter"));
            if (id === "app.interrupt") return matchesKey(data, Key.escape);
            if (id === "app.exit") return matchesKey(data, Key.ctrl("d"));
            return false;
          },
        };
        const component = factory(tui, theme, keybindings, resolve);
        const lines = component.render(32);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= 32), "custom views must obey terminal width");
        const sequence = keys.shift();
        assert.ok(sequence !== undefined, "test supplied input for every view");
        for (const key of sequence) component.handleInput(key);
        component.dispose?.();
      }),
    },
  };

  await events.get("session_start")!({}, ctx);
  await commands.get("threads")!.handler("", ctx);
  assert.deepEqual(deliveries, ["prompt", "steer", "followUp"]);
  assert.equal(aborts, 1, "takeover abort targets only the selected worker");
  assert.deepEqual(keys, [], "detach returned to the dashboard, which then closed normally");
  assert.ok(renderRequests > 0, "live snapshot updates request terminal renders");
  assert.equal(inputs.length, 0, "dialog focus returned each entered value to the corresponding takeover action");
  assert.ok(notifications.some((message) => /not delivered.*remains/i.test(message)), "failed delivery remains in the attached thread editor");
});

test("new threads ask only for isolation, use the foreground cwd, trust the project, and open attached", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  const listeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  let threads: ThreadSnapshot[] = [];
  const launches: unknown[] = [];
  const snapshot = (): SupervisorSnapshot => ({ protocolVersion: 5, supervisorPid: 1, threads: structuredClone(threads) });
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const supervisor: AgentViewSupervisor = {
    async connect() { return snapshot(); }, disconnect() {},
    onSnapshot(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    async snapshot() { return snapshot(); },
    async launch(input) {
      launches.push(input);
      const launched = { ...structuredClone(baseThread), name: "New thread", namePending: true, cwd: input.cwd, project: input.cwd, projectTrusted: Boolean(input.projectTrusted) };
      threads = [launched];
      emit();
      return structuredClone(launched);
    },
    async adopt() { throw new Error("unused"); }, async stop() { throw new Error("unused"); },
    async resume() { throw new Error("unused"); }, async delete() { throw new Error("unused"); },
    async sendMessage() { throw new Error("unused"); }, async answer() { throw new Error("unused"); },
    async abort() { throw new Error("unused"); },
    async transcript() { return { entries: [], hasMore: false }; },
  };
  const pi = {
    registerFlag() {}, getFlag() { return true; },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) { events.set(name, handler); },
  };
  createAgentViewExtension(() => supervisor)(pi as any);

  const viewKeys = [["n"], ["\x04"], ["q"]];
  const asked: string[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx = {
    mode: "tui", cwd: "/foreground-project",
    ui: {
      theme, notify: () => undefined, setStatus: () => undefined, setEditorText: () => undefined,
      input: async () => { throw new Error("new thread must not ask for text input"); },
      editor: async () => { throw new Error("new thread must not open a setup editor"); },
      confirm: async () => { throw new Error("new thread must not ask for confirmation"); },
      select: async (title: string) => { asked.push(title); return "Isolated Git worktree (recommended)"; },
      custom: async (factory: any) => await new Promise((resolve) => {
        const tui = { terminal: { rows: 18 }, requestRender: () => undefined };
        const keybindings = {
          matches(data: string, id: string) {
            if (id === "app.exit") return matchesKey(data, Key.ctrl("d"));
            if (id === "app.interrupt") return matchesKey(data, Key.escape);
            if (id === "app.message.followUp") return matchesKey(data, Key.alt("enter"));
            if (id === "tui.input.submit") return matchesKey(data, Key.enter);
            return false;
          },
        };
        const component = factory(tui, theme, keybindings, resolve);
        const sequence = viewKeys.shift();
        assert.ok(sequence);
        for (const key of sequence) component.handleInput(key);
        component.dispose?.();
      }),
    },
  };

  await events.get("session_start")!({}, ctx);
  await commands.get("threads")!.handler("", ctx);

  assert.deepEqual(asked, ["Checkout isolation"]);
  assert.deepEqual(launches, [{ cwd: "/foreground-project", isolation: "required", projectTrusted: true }]);
  assert.deepEqual(viewKeys, [], "new thread opened attached, detached, then returned to the dashboard");
});
