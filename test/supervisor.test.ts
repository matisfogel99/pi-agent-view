import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { getSupervisorPaths } from "../src/paths.ts";
import type { SupervisorSnapshot, ThreadSnapshot } from "../src/protocol.ts";
import { SupervisorClient } from "../src/supervisor-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "supervisor-entry.ts");
const fakeWorker = join(here, "fixtures", "fake-rpc-worker.mjs");
const execFileAsync = promisify(execFile);

async function harness(t: test.TestContext, extraEnv: NodeJS.ProcessEnv = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-agent-view-"));
  const paths = getSupervisorPaths(stateDir);
  let daemon = startDaemon(stateDir, extraEnv);
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

function startDaemon(stateDir: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [entry], {
    stdio: "ignore",
    env: {
      ...process.env,
      PI_AGENT_VIEW_STATE_DIR: stateDir,
      PI_AGENT_VIEW_WORKER_COMMAND: process.execPath,
      PI_AGENT_VIEW_WORKER_ARGS: JSON.stringify([fakeWorker]),
      ...extraEnv,
    },
  });
}

test("client automatically starts the user-local supervisor on first use", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-agent-view-auto-"));
  const client = new SupervisorClient({ paths: getSupervisorPaths(stateDir), connectTimeoutMs: 4_000 });
  t.after(() => client.disconnect());
  const snapshot = await client.connect();
  assert.equal(snapshot.protocolVersion, 5);
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
  assert.equal((await stat(h.paths.lockPath)).mode & 0o777, 0o600);
  assert.equal((await stat(h.paths.socketPath)).mode & 0o777, 0o600);
  assert.equal((await stat(h.paths.sessionsDir)).mode & 0o777, 0o700);
  assert.equal((await stat(h.paths.worktreesDir)).mode & 0o777, 0o700);
});

test("an unnamed worker starts as New thread and adopts the agent-generated name after its first prompt", async (t) => {
  const argsLog = join(await mkdtemp(join(tmpdir(), "pi-agent-view-name-")), "args.jsonl");
  const h = await harness(t, { PI_AGENT_VIEW_FAKE_ARGS_LOG: argsLog });

  const launched = await h.client.launch({ cwd: tmpdir(), projectTrusted: true });
  assert.equal(launched.name, "New thread");
  assert.equal(launched.namePending, true);

  await h.client.sendMessage(launched.id, "prompt", "repair flaky tests");
  const named = await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.namePending === false);
  assert.equal(named.name, "AI: repair flaky tests");

  const workerArgs = JSON.parse((await readFile(argsLog, "utf8")).trim().split("\n")[0]!);
  assert.ok(workerArgs.includes("--approve"));
  assert.equal(workerArgs.includes("--name"), false, "placeholder names must not become persisted Pi session names");
});

test("supervisor reports worker failure without credentials or network access", async (t) => {
  const h = await harness(t);
  const launched = await h.client.launch({ cwd: tmpdir(), prompt: "fail" });
  const failed = await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.state === "failed");
  assert.match(failed.error ?? "", /agent error/);
  await h.client.stop(launched.id);
});

test("adoption, duplicate ownership, needs-input, resume, and safe deletion work through the client interface", async (t) => {
  const h = await harness(t);
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-agent-view-existing-"));
  const sessionFile = join(sessionDir, "existing.jsonl");
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "existing-session", cwd: tmpdir(), timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "session_info", id: "name", parentId: null, timestamp: new Date().toISOString(), name: "Existing work" }),
    JSON.stringify({ type: "message", id: "message", parentId: "name", timestamp: new Date().toISOString(), message: { role: "user", content: "metadata needle" } }),
    "",
  ].join("\n"));

  const adopted = await h.client.adopt({ sessionFile });
  assert.equal(adopted.name, "Existing work");
  assert.equal(adopted.sessionOrigin, "adopted");
  assert.match(adopted.transcriptMetadata ?? "", /metadata needle/);
  await assert.rejects(h.client.adopt({ sessionFile }), /already owned/);

  const waiting = await h.client.launch({ cwd: tmpdir(), name: "Waiting", prompt: "wait" });
  const needsInput = await waitForSnapshot(h.client, (thread) => thread.id === waiting.id && thread.state === "needs-input");
  assert.match(needsInput.activity ?? "", /Waiting/);

  await h.client.stop(adopted.id);
  const resumed = await waitFor(() => h.client.resume(adopted.id), 3_000);
  assert.equal(resumed.id, adopted.id);
  assert.equal(resumed.sessionFile, sessionFile);
  await h.client.stop(adopted.id);
  await assert.rejects(h.client.delete(adopted.id, false), /explicit confirmation/);
  const deleted = await waitFor(() => h.client.delete(adopted.id, true), 3_000);
  assert.equal(deleted.recordRemoved, true);
  assert.equal(deleted.transcriptDeleted, false);
  assert.deepEqual(deleted.preservedPaths, [sessionFile]);
  await access(sessionFile);

  await h.client.stop(waiting.id);
  const managedDeletion = await waitFor(() => h.client.delete(waiting.id, true), 3_000);
  assert.equal(managedDeletion.transcriptDeleted, true);
  await assert.rejects(access(waiting.sessionFile!));
});

test("interactive commands, UI answers, abort, and cursor-bounded transcripts work through the supervisor interface", async (t) => {
  const h = await harness(t);
  const launched = await h.client.launch({ cwd: tmpdir(), name: "Interactive", prompt: "choose" });
  const waiting = await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.state === "needs-input");
  assert.equal(waiting.pendingRequest?.method, "select");
  assert.deepEqual(waiting.pendingRequest?.options, ["alpha", "beta"]);
  assert.match(waiting.recentOutput ?? "", /deterministic output/, "preview output streams into bounded snapshot state");
  await assert.rejects(h.client.answer(launched.id, { requestId: "ui-1", value: "invalid" }), /not available/);
  assert.equal((await h.client.snapshot()).threads.find((thread) => thread.id === launched.id)?.state, "needs-input");

  await h.client.answer(launched.id, { requestId: "ui-1", value: "alpha" });
  await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.state === "ready");
  const initialPage = await h.client.transcript(launched.id, undefined, 2);
  assert.equal(initialPage.entries.length, 2);
  assert.equal(initialPage.hasMore, true);
  assert.ok(initialPage.startCursor);
  assert.ok(initialPage.cursor);
  const olderPage = await h.client.transcript(launched.id, undefined, 2, initialPage.startCursor);
  assert.ok(olderPage.entries.length > 0, "older transcript pages remain reachable without unbounded client retention");

  await h.client.sendMessage(launched.id, "prompt", "second run");
  await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.state === "working");
  await h.client.sendMessage(launched.id, "steer", "change direction");
  await h.client.sendMessage(launched.id, "followUp", "then summarize");
  await h.client.abort(launched.id);
  await waitForSnapshot(h.client, (thread) => thread.id === launched.id && thread.state === "ready");

  const incremental = await h.client.transcript(launched.id, initialPage.cursor, 20);
  const transcriptText = JSON.stringify(incremental.entries);
  assert.match(transcriptText, /second run/);
  assert.match(transcriptText, /change direction/);
  assert.match(transcriptText, /then summarize/);
  await h.client.stop(launched.id);
});

test("Git workers default to managed worktrees and deletion safely handles every checkout condition", async (t) => {
  const h = await harness(t);
  const repository = await mkdtemp(join(tmpdir(), "pi-agent-view-git-"));
  await execFileAsync("git", ["-C", repository, "init", "-q"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Agent View Test"]);
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
  await execFileAsync("git", ["-C", repository, "commit", "-qm", "base"]);

  const adoptedSession = join(await mkdtemp(join(tmpdir(), "pi-agent-view-git-session-")), "session.jsonl");
  await writeFile(adoptedSession, `${JSON.stringify({ type: "session", version: 3, id: "git-adopt", cwd: repository })}\n`);
  await assert.rejects(h.client.adopt({ sessionFile: adoptedSession }), /explicit shared-checkout approval/);
  const adopted = await h.client.adopt({ sessionFile: adoptedSession, allowSharedCheckout: true });
  assert.equal(adopted.checkout.mode, "shared");
  await h.client.stop(adopted.id);
  await h.client.delete(adopted.id, true);

  const clean = await h.client.launch({ cwd: repository, name: "Clean" });
  assert.equal(clean.checkout.mode, "worktree");
  assert.equal(clean.checkout.managed, true);
  assert.equal(clean.project, await realpath(repository));
  assert.notEqual(clean.checkout.path, clean.project);
  assert.equal(clean.cwd, clean.checkout.path);
  await h.client.stop(clean.id);
  const cleanDeletion = await h.client.delete(clean.id, true);
  assert.equal(cleanDeletion.checkoutRemoved, true);
  await assert.rejects(access(clean.checkout.path));

  const dirty = await h.client.launch({ cwd: repository, name: "Dirty" });
  await writeFile(join(dirty.checkout.path, "dirty.txt"), "uncommitted\n");
  await h.client.stop(dirty.id);
  const dirtyDeletion = await h.client.delete(dirty.id, true);
  assert.equal(dirtyDeletion.checkoutRemoved, false);
  assert.ok(dirtyDeletion.preservedPaths.includes(dirty.checkout.path));
  assert.match(dirtyDeletion.warnings.join(" "), /uncommitted changes/);

  const committed = await h.client.launch({ cwd: repository, name: "Unpushed" });
  await writeFile(join(committed.checkout.path, "commit.txt"), "valuable\n");
  await execFileAsync("git", ["-C", committed.checkout.path, "add", "commit.txt"]);
  await execFileAsync("git", ["-C", committed.checkout.path, "commit", "-qm", "worker change"]);
  await h.client.stop(committed.id);
  const committedDeletion = await h.client.delete(committed.id, true);
  assert.equal(committedDeletion.checkoutRemoved, false);
  assert.match(committedDeletion.warnings.join(" "), /may be unpushed/);
  await access(committed.checkout.path);

  const shared = await h.client.launch({ cwd: repository, name: "Shared", isolation: "shared" });
  assert.equal(shared.checkout.mode, "shared");
  assert.match(shared.checkout.warning ?? "", /explicitly disabled/);
  await h.client.stop(shared.id);
  const sharedDeletion = await h.client.delete(shared.id, true);
  assert.equal(sharedDeletion.checkoutRemoved, false);
  assert.match(sharedDeletion.warnings.join(" "), /shared checkout/i);
  await access(repository);

  const external = await h.client.launch({ cwd: repository, name: "External" });
  await h.client.stop(external.id);
  await execFileAsync("git", ["-C", repository, "worktree", "remove", "--force", external.checkout.path]);
  const externalDeletion = await h.client.delete(external.id, true);
  assert.equal(externalDeletion.checkoutRemoved, false);
  assert.match(externalDeletion.warnings.join(" "), /removed externally/);

  await rm(dirty.checkout.path, { recursive: true, force: true });
  await rm(committed.checkout.path, { recursive: true, force: true });
});

test("worker trust is explicit and scoped through Pi's approve flags", async (t) => {
  const argsLog = join(await mkdtemp(join(tmpdir(), "pi-agent-view-trust-")), "args.jsonl");
  const h = await harness(t, { PI_AGENT_VIEW_FAKE_ARGS_LOG: argsLog });
  const untrusted = await h.client.launch({ cwd: tmpdir(), name: "Untrusted" });
  const trusted = await h.client.launch({ cwd: tmpdir(), name: "Trusted", projectTrusted: true });
  await h.client.stop(untrusted.id);
  await h.client.stop(trusted.id);
  const invocations = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.ok(invocations.some((args) => args.includes("--no-approve")));
  assert.ok(invocations.some((args) => args.includes("--approve")));
  assert.equal(untrusted.projectTrusted, false);
  assert.equal(trusted.projectTrusted, true);
});

test("malformed, oversized, partial, delayed, and unexpected worker records cannot wedge the supervisor", async (t) => {
  const h = await harness(t, { PI_AGENT_VIEW_RPC_TIMEOUT_MS: "100" });

  const partial = await h.client.launch({ cwd: tmpdir(), name: "Partial", prompt: "partial" });
  const partialReady = await waitForSnapshot(h.client, (thread) => thread.id === partial.id && thread.state === "ready");
  assert.match(partialReady.recentOutput ?? "", /partial result/);

  const malformed = await h.client.launch({ cwd: tmpdir(), name: "Malformed", prompt: "malformed" });
  const malformedFailure = await waitForSnapshot(h.client, (thread) => thread.id === malformed.id && thread.state === "failed");
  assert.match(malformedFailure.error ?? "", /Invalid JSONL/);

  const oversized = await h.client.launch({ cwd: tmpdir(), name: "Oversized", prompt: "oversized" });
  const oversizedFailure = await waitForSnapshot(h.client, (thread) => thread.id === oversized.id && thread.state === "failed");
  assert.match(oversizedFailure.error ?? "", /exceeds/);

  const bounded = await h.client.launch({ cwd: tmpdir(), name: "Bounded", prompt: "bounded" });
  const boundedReady = await waitForSnapshot(h.client, (thread) => thread.id === bounded.id && thread.state === "ready");
  assert.ok((boundedReady.recentOutput?.length ?? 0) <= 12_000);
  assert.ok((boundedReady.transcriptMetadata?.length ?? 0) <= 8_000);

  const delayed = await h.client.launch({ cwd: tmpdir(), name: "Delayed" });
  await assert.rejects(h.client.sendMessage(delayed.id, "prompt", "delayed"), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const recovered = await h.client.sendMessage(delayed.id, "prompt", "normal after timeout");
  assert.equal(recovered.state, "working");
  await waitForSnapshot(h.client, (thread) => thread.id === delayed.id && thread.state === "ready");

  const stillResponsive = await h.client.snapshot();
  assert.ok(stillResponsive.threads.length >= 5);
});

test("multiple clients serialize duplicate controls without corrupting worker state", async (t) => {
  const h = await harness(t);
  const second = new SupervisorClient({ paths: h.paths, autoStart: false, connectTimeoutMs: 2_000 });
  t.after(() => second.disconnect());
  await second.connect();
  const launched = await h.client.launch({ cwd: tmpdir(), name: "Shared control" });
  const results = await Promise.allSettled([
    h.client.sendMessage(launched.id, "prompt", "first"),
    second.sendMessage(launched.id, "prompt", "second"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await waitForSnapshot(second, (thread) => thread.id === launched.id && thread.state === "ready");
});

test("incompatible protocol versions are rejected clearly", async (t) => {
  const h = await harness(t);
  const incompatible = new SupervisorClient({ paths: h.paths, protocolVersion: 999, autoStart: false });
  t.after(() => incompatible.disconnect());
  await assert.rejects(incompatible.connect(), /Incompatible supervisor protocol: client 999, server 5/);
});

test("one supervisor owns the registry", async (t) => {
  const h = await harness(t);
  const contender = startDaemon(h.paths.stateDir);
  const code = await new Promise<number | null>((resolve) => contender.once("exit", resolve));
  assert.equal(code, 1);
  const snapshot = await h.client.snapshot();
  assert.equal(snapshot.supervisorPid, h.daemon.pid);
});

test("graceful shutdown terminates workers, releases ownership, and leaves recovery diagnostics", async (t) => {
  const h = await harness(t);
  const launched = await h.client.launch({ cwd: tmpdir(), name: "Shutdown recovery" });
  await h.client.shutdownSupervisor();
  if (h.daemon.exitCode === null && h.daemon.signalCode === null) await new Promise<void>((resolve) => h.daemon.once("exit", () => resolve()));
  await assert.rejects(access(h.paths.lockPath));
  await assert.rejects(access(h.paths.socketPath));
  assert.equal(isAlive(launched.pid!), false);

  h.daemon = startDaemon(h.paths.stateDir);
  const later = new SupervisorClient({ paths: h.paths, autoStart: false, connectTimeoutMs: 2_000 });
  t.after(() => later.disconnect());
  const snapshot = await waitFor(() => later.connect(), 3_000);
  const recovered = snapshot.threads.find((thread) => thread.id === launched.id);
  assert.equal(recovered?.state, "failed");
  assert.match(recovered?.error ?? "", /Supervisor shut down/);
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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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
