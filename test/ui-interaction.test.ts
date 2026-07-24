import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAgentViewExtension, type AgentViewSupervisor } from "../src/index.ts";
import type { SupervisorSnapshot, ThreadMessageMode, ThreadSnapshot } from "../src/protocol.ts";

const baseThread: ThreadSnapshot = {
  id: "thread-1", cwd: "/project", project: "/project", name: "Interactive thread", state: "ready",
  sessionOrigin: "created", sessionFile: "/tmp/session.jsonl",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", recentOutput: "recent result",
};

test("Space preview, input focus handoff, takeover controls, live rendering, and detach work without touching foreground Pi", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const listeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  let thread = structuredClone(baseThread);
  const deliveries: ThreadMessageMode[] = [];
  const notifications: string[] = [];
  let restoredInput: string | undefined;
  let aborts = 0;
  const snapshot = (): SupervisorSnapshot => ({ protocolVersion: 3, supervisorPid: 1, threads: [structuredClone(thread)] });
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
    on() {},
  };
  createAgentViewExtension(() => supervisor)(pi as any);

  const keys = [" ", "r", "\r", "s", "f", "a", "q", "q"];
  const inputs = ["normal reply", "steering reply", "follow-up reply"];
  let renderRequests = 0;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx = {
    mode: "tui", cwd: "/foreground", isIdle: () => false,
    abort: () => { throw new Error("foreground must not be aborted"); },
    waitForIdle: () => { throw new Error("foreground must not be awaited"); },
    ui: {
      theme,
      notify: (message: string) => { notifications.push(message); }, setStatus: () => undefined,
      setEditorText: (value: string) => { restoredInput = value; },
      input: async () => inputs.shift(), editor: async () => undefined, select: async () => undefined, confirm: async () => false,
      custom: async (factory: any) => await new Promise((resolve) => {
        const tui = { terminal: { rows: 18 }, requestRender: () => { renderRequests++; } };
        const component = factory(tui, theme, {}, resolve);
        const lines = component.render(32);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= 32), "custom views must obey terminal width");
        const key = keys.shift();
        assert.ok(key !== undefined, "test supplied an input for every view");
        component.handleInput(key);
        component.dispose?.();
      }),
    },
  };

  await commands.get("threads")!.handler("", ctx);
  assert.deepEqual(deliveries, ["prompt", "steer", "followUp"]);
  assert.equal(aborts, 1, "takeover abort targets only the selected worker");
  assert.deepEqual(keys, [], "detach returned to the dashboard, which then closed normally");
  assert.ok(renderRequests > 0, "live snapshot updates request terminal renders");
  assert.equal(inputs.length, 0, "dialog focus returned each entered value to the corresponding takeover action");
  assert.equal(restoredInput, "follow-up reply", "failed delivery restores user input instead of discarding it");
  assert.ok(notifications.some((message) => /not delivered.*restored/i.test(message)), "failed delivery is reported clearly");
});
