import assert from "node:assert/strict";
import test from "node:test";
import { createAgentViewExtension, type AgentViewSupervisor } from "../src/index.ts";
import type { SupervisorSnapshot, ThreadSnapshot } from "../src/protocol.ts";

function setup(flag = false) {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  let registeredFlag: unknown;
  let connects = 0;
  let disconnects = 0;
  let stops = 0;
  let customViews = 0;
  const snapshot: SupervisorSnapshot = { protocolVersion: 3, supervisorPid: 123, threads: [] };
  const client: AgentViewSupervisor = {
    async connect() { connects++; return snapshot; },
    disconnect() { disconnects++; },
    onSnapshot(listener) { listener(snapshot); return () => undefined; },
    async snapshot() { return snapshot; },
    async launch() { throw new Error("not used"); },
    async adopt() { throw new Error("not used"); },
    async stop() { stops++; return {} as ThreadSnapshot; },
    async resume() { throw new Error("not used"); },
    async delete() { throw new Error("not used"); },
    async sendMessage() { throw new Error("not used"); },
    async answer() { throw new Error("not used"); },
    async abort() { throw new Error("not used"); },
    async transcript() { return { entries: [], hasMore: false }; },
  };
  const pi = {
    registerFlag(name: string, options: unknown) { registeredFlag = { name, options }; },
    getFlag() { return flag; },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
    on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) { events.set(name, handler); },
  };
  createAgentViewExtension(() => client)(pi as any);
  const notifications: Array<{ message: string; type: string }> = [];
  const statuses: unknown[] = [];
  const ctx = {
    mode: "tui",
    cwd: "/tmp",
    isIdle: () => false,
    abort: () => { throw new Error("must not abort foreground turn"); },
    waitForIdle: () => { throw new Error("must not wait for foreground turn"); },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string, type: string) => notifications.push({ message, type }),
      setStatus: (_key: string, value: unknown) => statuses.push(value),
      custom: async () => { customViews++; return { type: "close" }; },
      input: async () => undefined,
      editor: async () => undefined,
      select: async () => undefined,
      confirm: async () => false,
      setEditorText: () => undefined,
    },
  };
  return { commands, events, registeredFlag, notifications, statuses, ctx, counts: () => ({ connects, disconnects, stops, customViews }) };
}

test("mode controls and helpful threads guidance remain safe during a foreground turn", async () => {
  const h = setup(false);
  assert.equal((h.registeredFlag as { name: string }).name, "agent-mode");

  await h.commands.get("threads")!.handler("", h.ctx);
  assert.match(h.notifications.at(-1)!.message, /\/agent-mode on|--agent-mode/);
  assert.equal(h.counts().connects, 0, "off mode must remain inert");

  await h.commands.get("agent-mode")!.handler("on", h.ctx);
  assert.equal(h.counts().connects, 1);
  assert.match(h.notifications.at(-1)!.message, /enabled/);

  await h.commands.get("threads")!.handler("", h.ctx);
  assert.equal(h.counts().customViews, 1, "the full-screen dashboard must open without waiting for the foreground turn");

  await h.commands.get("agent-mode")!.handler("status", h.ctx);
  assert.match(h.notifications.at(-1)!.message, /is on/);

  await h.commands.get("agent-mode")!.handler("off", h.ctx);
  assert.equal(h.counts().disconnects, 1);
  assert.equal(h.counts().stops, 0, "turning mode off must not stop workers");
  assert.match(h.notifications.at(-1)!.message, /left running/);
});

test("startup flag connects lazily at session start and shutdown only disconnects", async () => {
  const h = setup(true);
  assert.equal(h.counts().connects, 0, "extension factory must not start background resources");
  await h.events.get("session_start")!({}, h.ctx);
  assert.equal(h.counts().connects, 1);
  await h.events.get("session_shutdown")!({}, h.ctx);
  assert.equal(h.counts().disconnects, 1);
  assert.equal(h.counts().stops, 0);
});
