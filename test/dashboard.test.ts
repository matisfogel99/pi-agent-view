import assert from "node:assert/strict";
import test from "node:test";
import { DashboardController } from "../src/dashboard.ts";
import type { AgentViewSupervisor } from "../src/index.ts";
import type { DeleteThreadResult, SupervisorSnapshot, ThreadSnapshot, TranscriptPage } from "../src/protocol.ts";

function thread(overrides: Partial<ThreadSnapshot> & Pick<ThreadSnapshot, "id" | "name" | "project">): ThreadSnapshot {
  return {
    cwd: overrides.project,
    state: "ready",
    sessionOrigin: "created",
    checkout: { mode: "directory", path: overrides.project, managed: false },
    projectTrusted: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activity: "Ready",
    ...overrides,
  };
}

class InMemorySupervisor implements AgentViewSupervisor {
  private listeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  readonly data: SupervisorSnapshot = { protocolVersion: 5, supervisorPid: 42, threads: [] };
  async connect() { return this.snapshot(); }
  disconnect() {}
  onSnapshot(listener: (snapshot: SupervisorSnapshot) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async snapshot() { return structuredClone(this.data); }
  async launch(input: { cwd: string; name?: string }): Promise<ThreadSnapshot> {
    const value = thread({ id: `thread-${this.data.threads.length + 1}`, name: input.name || "New thread", project: input.cwd });
    this.data.threads.push(value); this.emit(); return structuredClone(value);
  }
  async adopt(): Promise<ThreadSnapshot> { throw new Error("not needed"); }
  async stop(id: string): Promise<ThreadSnapshot> { return this.change(id, "stopped"); }
  async resume(id: string): Promise<ThreadSnapshot> { return this.change(id, "ready"); }
  async sendMessage(): Promise<ThreadSnapshot> { throw new Error("not needed"); }
  async answer(): Promise<ThreadSnapshot> { throw new Error("not needed"); }
  async abort(): Promise<ThreadSnapshot> { throw new Error("not needed"); }
  async transcript(): Promise<TranscriptPage> { return { entries: [], hasMore: false }; }
  async delete(id: string, confirmed: boolean): Promise<DeleteThreadResult> {
    if (!confirmed) throw new Error("confirmation required");
    const index = this.data.threads.findIndex((candidate) => candidate.id === id);
    if (index < 0 || this.data.threads[index]!.state !== "stopped") throw new Error("stopped only");
    this.data.threads.splice(index, 1); this.emit();
    return { id, recordRemoved: true, transcriptDeleted: true, checkoutRemoved: false, preservedPaths: [], warnings: [] };
  }
  update(value: ThreadSnapshot) {
    const index = this.data.threads.findIndex((candidate) => candidate.id === value.id);
    if (index >= 0) this.data.threads[index] = value; else this.data.threads.push(value);
    this.emit();
  }
  private async change(id: string, state: ThreadSnapshot["state"]) {
    const value = this.data.threads.find((candidate) => candidate.id === id);
    if (!value) throw new Error("unknown");
    value.state = state; this.emit(); return structuredClone(value);
  }
  private emit() { for (const listener of this.listeners) listener(structuredClone(this.data)); }
}

test("dashboard groups, searches metadata, and preserves identity selection and preferences across live updates", async () => {
  const supervisor = new InMemorySupervisor();
  supervisor.data.threads.push(
    thread({ id: "a", name: "API work", project: "/projects/alpha", state: "working", activity: "Using bash", updatedAt: "2026-01-03T00:00:00.000Z" }),
    thread({ id: "b", name: "UI work", project: "/projects/alpha", transcriptMetadata: "rare transcript needle", updatedAt: "2026-01-02T00:00:00.000Z" }),
    thread({ id: "c", name: "Release", project: "/projects/beta", state: "failed", updatedAt: "2026-01-01T00:00:00.000Z" }),
  );
  const dashboard = new DashboardController(await supervisor.connect());
  const off = supervisor.onSnapshot((snapshot) => dashboard.applySnapshot(snapshot));

  assert.deepEqual(dashboard.groups().map((group) => group.key), ["project:/projects/alpha", "project:/projects/beta"]);
  dashboard.move(1);
  assert.equal(dashboard.selectedThreadId(), "b");

  supervisor.update(thread({ id: "b", name: "UI work", project: "/projects/alpha", transcriptMetadata: "rare transcript needle", updatedAt: "2026-01-04T00:00:00.000Z" }));
  assert.equal(dashboard.selectedThreadId(), "b", "a live resort must retain thread identity selection");

  dashboard.setSearch("needle");
  assert.deepEqual(dashboard.visibleThreads().map((value) => value.id), ["b"]);
  dashboard.setSearch("");
  dashboard.toggleSelectedProject();
  assert.equal(dashboard.groups().find((group) => group.key === "project:/projects/alpha")!.expanded, false);

  dashboard.toggleGrouping();
  assert.deepEqual(dashboard.groups().map((group) => group.label), ["Working", "Ready", "Failed"]);
  dashboard.toggleSort();
  dashboard.toggleGrouping();
  assert.equal(dashboard.preferences.sort, "name");
  assert.equal(dashboard.groups().find((group) => group.key === "project:/projects/alpha")!.expanded, false, "project expansion survives reopening/group toggles");

  const launched = await supervisor.launch({ cwd: "/projects/beta", name: "Lifecycle" });
  assert.equal((await supervisor.stop(launched.id)).state, "stopped");
  assert.equal((await supervisor.resume(launched.id)).state, "ready");
  await supervisor.stop(launched.id);
  assert.equal((await supervisor.delete(launched.id, true)).recordRemoved, true);
  off();
});
