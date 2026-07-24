import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getSupervisorPaths } from "../src/paths.ts";
import type { SupervisorSnapshot, ThreadSnapshot } from "../src/protocol.ts";
import { SupervisorClient } from "../src/supervisor-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "supervisor-entry.ts");
const fakeWorker = join(here, "fixtures", "fake-rpc-worker.mjs");

async function harness(t: test.TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-agent-view-"));
  const paths = getSupervisorPaths(stateDir);
  let daemon = startDaemon(stateDir);
  const client = new SupervisorClient({ paths, autoStart: false, connectTimeoutMs: 2_000 });
  await waitFor(() => client.connect(), 3_000);
  t.after(() => {
    client.disconnect();
    if (!daemon.killed) daemon.kill("SIGKILL");
  });
  return {
    paths,
    client,
    get daemon() { return daemon; },
    set daemon(value: ChildProcess) { daemon = value; },
  };
}

function startDaemon(stateDir: string): ChildProcess {
  return spawn(process.execPath, [entry], {
    stdio: "ignore",
    env: {
      ...process.env,
      PI_AGENT_VIEW_STATE_DIR: stateDir,
      PI_AGENT_VIEW_WORKER_COMMAND: process.execPath,
      PI_AGENT_VIEW_WORKER_ARGS: JSON.stringify([fakeWorker]),
    },
  });
}

test("client automatically starts the user-local supervisor on first use", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-agent-view-auto-"));
  const client = new SupervisorClient({ paths: getSupervisorPaths(stateDir), connectTimeoutMs: 4_000 });
  t.after(() => client.disconnect());
  const snapshot = await client.connect();
  assert.equal(snapshot.protocolVersion, 1);
  assert.ok(snapshot.supervisorPid > 0);
  await client.shutdownSupervisor();
});

test("real supervisor launches a persistent RPC worker and streams truthful lifecycle snapshots", async (t) => {
  const h = await harness(t);
  const observed: string[] = [];
  const off = h.client.onSnapshot((snapshot) => {
    const state = snapshot.threads[0]?.state;
    if (state) observed.push(state);
  });

  const launched = await h.client.launch({ cwd: tmpdir(), name: "Lifecycle", prompt: "work" });
  assert.equal(launched.name, "Lifecycle");
  assert.ok(launched.sessionFile);
  await access(launched.sessionFile!);
  await waitForSnapshot(h.client, (thread) => thread.state === "working");
  const ready = await waitForSnapshot(h.client, (thread) => thread.state === "ready");
  assert.equal(ready.pid, launched.pid);
  assert.ok(observed.includes("starting"));
  assert.ok(observed.includes("working"));
  assert.ok(observed.includes("ready"));

  h.client.disconnect();
  const laterClient = new SupervisorClient({ paths: h.paths, autoStart: false });
  t.after(() => laterClient.disconnect());
  const reconnected = await laterClient.connect();
  assert.equal(reconnected.threads[0]?.id, launched.id);
  assert.equal(reconnected.threads[0]?.sessionFile, launched.sessionFile);
  assert.equal(reconnected.threads[0]?.state, "ready");

  const stopped = await laterClient.stop(launched.id);
  assert.equal(stopped.state, "stopped");
  await waitForSnapshot(laterClient, (thread) => thread.state === "stopped");
  off();

  assert.equal((await stat(h.paths.stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(h.paths.registryPath)).mode & 0o777, 0o600);
  assert.equal((await stat(h.paths.socketPath)).mode & 0o777, 0o600);
});

test("supervisor reports worker failure without credentials or network access", async (t) => {
  const h = await harness(t);
  const launched = await h.client.launch({ cwd: tmpdir(), prompt: "fail" });
  const failed = await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.state === "failed");
  assert.match(failed.error ?? "", /agent error/);
  await h.client.stop(launched.id);
});

test("incompatible protocol versions are rejected clearly", async (t) => {
  const h = await harness(t);
  const incompatible = new SupervisorClient({ paths: h.paths, protocolVersion: 999, autoStart: false });
  t.after(() => incompatible.disconnect());
  await assert.rejects(incompatible.connect(), /Incompatible supervisor protocol: client 999, server 1/);
});

test("one supervisor owns the registry", async (t) => {
  const h = await harness(t);
  const contender = startDaemon(h.paths.stateDir);
  const code = await new Promise<number | null>((resolve) => contender.once("exit", resolve));
  assert.equal(code, 1);
  const snapshot = await h.client.snapshot();
  assert.equal(snapshot.supervisorPid, h.daemon.pid);
});

test("restart reconciliation never reports disconnected workers as live", async (t) => {
  const h = await harness(t);
  const launched = await h.client.launch({ cwd: tmpdir(), name: "Recoverable" });
  await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.state === "ready");
  h.client.disconnect();
  h.daemon.kill("SIGKILL");
  await new Promise<void>((resolve) => h.daemon.once("exit", () => resolve()));

  h.daemon = startDaemon(h.paths.stateDir);
  const later = new SupervisorClient({ paths: h.paths, autoStart: false, connectTimeoutMs: 2_000 });
  t.after(() => later.disconnect());
  const snapshot = await waitFor(() => later.connect(), 3_000);
  const recovered = snapshot.threads.find((thread) => thread.id === launched.id);
  assert.equal(recovered?.state, "failed");
  assert.match(recovered?.error ?? "", /Supervisor restarted/);
  assert.equal(recovered?.sessionFile, launched.sessionFile);

  const registry = JSON.parse(await readFile(h.paths.registryPath, "utf8")) as { threads: ThreadSnapshot[] };
  assert.notEqual(registry.threads[0]?.state, "working");
  assert.notEqual(registry.threads[0]?.state, "ready");
});

async function waitForSnapshot(client: SupervisorClient, predicate: (thread: ThreadSnapshot) => boolean): Promise<ThreadSnapshot> {
  return await waitFor(async () => {
    const snapshot = await client.snapshot();
    const match = snapshot.threads.find(predicate);
    if (!match) throw new Error(`State not reached: ${snapshot.threads.map((thread) => thread.state).join(",")}`);
    return match;
  }, 3_000);
}

async function waitFor<T>(operation: () => Promise<T>, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return await operation(); } catch (cause) { lastError = cause; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out");
}
