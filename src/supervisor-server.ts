import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { encodeJsonLine, readJsonLines } from "./jsonl.ts";
import { getSupervisorPaths, type SupervisorPaths } from "./paths.ts";
import {
  PROTOCOL_VERSION,
  type AdoptThreadInput,
  type ClientRequest,
  type DeleteThreadResult,
  type LaunchThreadInput,
  type ThreadCheckout,
  type ServerResponse,
  type PendingUiRequest,
  type SupervisorSnapshot,
  type ThreadMessageMode,
  type ThreadSnapshot,
  type TranscriptEntry,
  type TranscriptPage,
  type UiResponseInput,
} from "./protocol.ts";

interface RegistryFile {
  version: 1 | 2 | 3 | 4;
  threads: ThreadSnapshot[];
}

interface ManagedWorker {
  record: ThreadSnapshot;
  process: ChildProcessWithoutNullStreams;
  stopRequested: boolean;
  rpcSequence: number;
  pending: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
}

interface ClientOutputState {
  blocked: boolean;
  pendingSnapshot?: string;
}

interface SessionMetadata {
  file: string;
  cwd: string;
  id?: string;
  name?: string;
  searchText: string;
}

export interface SupervisorServerOptions {
  paths?: SupervisorPaths;
  workerCommand?: string;
  workerArgs?: string[];
  workerRpcTimeoutMs?: number;
}

const execFileAsync = promisify(execFile);
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_SEARCH_TEXT = 8_000;
const MAX_RECENT_OUTPUT = 12_000;
const MAX_TRANSCRIPT_PAGE = 200;
const MAX_TRANSCRIPT_ENTRY_BYTES = 64 * 1024;
const MAX_UI_TEXT = 4_000;
const MAX_WORKER_JSONL = 256 * 1024;
const MAX_CLIENT_JSONL = 1024 * 1024;
const MAX_CLIENT_REQUEST_HISTORY = 256;
const MAX_CLIENT_INFLIGHT = 64;
const DEFAULT_WORKER_RPC_TIMEOUT_MS = 10_000;

export class SupervisorServer {
  readonly paths: SupervisorPaths;
  private readonly workerCommand: string;
  private readonly workerArgs: string[];
  private readonly workerRpcTimeoutMs: number;
  private readonly records = new Map<string, ThreadSnapshot>();
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly clients = new Set<Socket>();
  private readonly lifecycleOperations = new Set<string>();
  private readonly requestOperations = new Set<Promise<void>>();
  private readonly clientRequests = new WeakMap<Socket, Map<string, "pending" | ServerResponse>>();
  private readonly clientOutput = new WeakMap<Socket, ClientOutputState>();
  private server?: Server;
  private lockHandle?: FileHandle;
  private persistTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;

  constructor(options: SupervisorServerOptions = {}) {
    this.paths = options.paths ?? getSupervisorPaths();
    this.workerCommand = options.workerCommand ?? process.env.PI_AGENT_VIEW_WORKER_COMMAND ?? "pi";
    this.workerArgs = options.workerArgs ?? parseWorkerArgs(process.env.PI_AGENT_VIEW_WORKER_ARGS);
    this.workerRpcTimeoutMs = options.workerRpcTimeoutMs ?? parsePositiveInteger(process.env.PI_AGENT_VIEW_RPC_TIMEOUT_MS) ?? DEFAULT_WORKER_RPC_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    await secureDirectory(this.paths.stateDir);
    await secureDirectory(this.paths.sessionsDir);
    await secureDirectory(this.paths.worktreesDir);
    this.lockHandle = await acquireSupervisorLock(this.paths.lockPath);
    try {
      await this.loadAndReconcile();
      await removeStaleSocket(this.paths.socketPath);

      this.server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.server!.once("error", onError);
        this.server!.listen(this.paths.socketPath, () => {
          this.server!.off("error", onError);
          resolve();
        });
      });
      await chmod(this.paths.socketPath, 0o600);
    } catch (cause) {
      await this.releaseLock();
      throw cause;
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    await Promise.allSettled([...this.requestOperations]);
    const workers = [...this.workers.values()];
    await Promise.all(workers.map(async (worker) => {
      if (!worker.stopRequested) {
        worker.record.state = "failed";
        worker.record.error = "Supervisor shut down; resume the persisted session to continue";
        worker.record.lastEvent = "worker terminated during supervisor shutdown";
        worker.record.activity = "Supervisor stopped worker; resume available";
        worker.record.updatedAt = new Date().toISOString();
      }
      await terminateWorker(worker.process);
    }));
    await this.persist();
    await rm(this.paths.socketPath, { force: true });
    await this.persistTail;
    await this.releaseLock();
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHandle) return;
    await this.lockHandle.close().catch(() => undefined);
    this.lockHandle = undefined;
    await rm(this.paths.lockPath, { force: true }).catch(() => undefined);
  }

  snapshot(): SupervisorSnapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      supervisorPid: process.pid,
      threads: [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((record) => ({ ...record })),
    };
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let authenticated = false;
    const requestHistory = new Map<string, "pending" | ServerResponse>();
    this.clientRequests.set(socket, requestHistory);
    this.clientOutput.set(socket, { blocked: false });
    const disposeReader = readJsonLines(socket, (value) => {
      if (!isObject(value)) return this.send(socket, { id: "unknown", type: "response", success: false, error: "Request must be an object" });
      if (!authenticated) {
        const id = typeof value.id === "string" ? value.id : "hello";
        if (value.type !== "hello" || value.protocolVersion !== PROTOCOL_VERSION) {
          this.send(socket, {
            id,
            type: "response",
            success: false,
            error: `Incompatible supervisor protocol: client ${String(value.protocolVersion)}, server ${PROTOCOL_VERSION}`,
          });
          socket.end();
          return;
        }
        authenticated = true;
        this.send(socket, { id, type: "response", success: true, data: this.snapshot() });
        return;
      }
      const id = typeof value.id === "string" ? value.id : "";
      if (!id) return this.send(socket, { id: "unknown", type: "response", success: false, error: "Requests require a string id" });
      const previous = requestHistory.get(id);
      if (previous === "pending") return; // The original request will produce the one correlated response.
      if (previous) return this.send(socket, previous, false);
      if ([...requestHistory.values()].filter((entry) => entry === "pending").length >= MAX_CLIENT_INFLIGHT) {
        return this.send(socket, { id, type: "response", success: false, error: "Too many client requests are in progress" }, false);
      }
      requestHistory.set(id, "pending");
      const operation = this.handleRequest(socket, value as unknown as ClientRequest);
      this.requestOperations.add(operation);
      void operation.finally(() => this.requestOperations.delete(operation));
    }, (error) => this.send(socket, { id: "parse", type: "response", success: false, error: error.message }), { maximumLineLength: MAX_CLIENT_JSONL });

    this.clients.add(socket);
    socket.once("close", () => {
      disposeReader();
      this.clients.delete(socket);
    });
    socket.on("error", () => undefined);
  }

  private async handleRequest(socket: Socket, request: ClientRequest): Promise<void> {
    if (request.type !== "request" || typeof request.id !== "string") return;
    try {
      let data: unknown;
      switch (request.method) {
        case "snapshot": data = this.snapshot(); break;
        case "launch": data = await this.launch(request.payload as LaunchThreadInput); break;
        case "adopt": data = await this.adopt(request.payload as AdoptThreadInput); break;
        case "stop": data = await this.stop(payloadId(request.payload)); break;
        case "resume": data = await this.resume(payloadId(request.payload)); break;
        case "delete": {
          const payload = request.payload as { id?: unknown; confirmed?: unknown } | undefined;
          data = await this.delete(String(payload?.id ?? ""), payload?.confirmed === true);
          break;
        }
        case "message": {
          const payload = request.payload as { id?: unknown; mode?: unknown; message?: unknown } | undefined;
          data = await this.sendMessage(String(payload?.id ?? ""), payload?.mode, payload?.message);
          break;
        }
        case "answer": {
          const payload = request.payload as ({ id?: unknown } & Partial<UiResponseInput>) | undefined;
          data = await this.answer(String(payload?.id ?? ""), payload ?? { requestId: "" });
          break;
        }
        case "abort": data = await this.abort(payloadId(request.payload)); break;
        case "transcript": {
          const payload = request.payload as { id?: unknown; cursor?: unknown; limit?: unknown; before?: unknown } | undefined;
          data = await this.transcript(
            String(payload?.id ?? ""),
            typeof payload?.cursor === "string" ? payload.cursor : undefined,
            Number(payload?.limit),
            typeof payload?.before === "string" ? payload.before : undefined,
          );
          break;
        }
        case "shutdown":
          data = { shuttingDown: true };
          this.send(socket, { id: request.id, type: "response", success: true, data });
          setTimeout(() => void this.close().finally(() => process.exit(0)), 20).unref();
          return;
        default: throw new Error(`Unknown supervisor method: ${String(request.method)}`);
      }
      this.send(socket, { id: request.id, type: "response", success: true, data });
    } catch (cause) {
      this.send(socket, { id: request.id, type: "response", success: false, error: errorMessage(cause) });
    }
  }

  private async launch(input: LaunchThreadInput): Promise<ThreadSnapshot> {
    if (!input || typeof input.cwd !== "string" || input.cwd.trim() === "") throw new Error("A working directory is required");
    const selectedCwd = await realpath(input.cwd);
    if (!(await stat(selectedCwd)).isDirectory()) throw new Error("The working directory is not a directory");
    if (input.isolation !== undefined && input.isolation !== "required" && input.isolation !== "shared") throw new Error("Unknown isolation policy");
    const id = randomUUID();
    const prepared = await prepareCheckout(selectedCwd, id, this.paths.worktreesDir, input.isolation ?? "required");
    const now = new Date().toISOString();
    const requestedName = input.name?.trim();
    const name = requestedName || "New thread";
    const sessionDir = join(this.paths.sessionsDir, id);
    await secureDirectory(sessionDir);

    const record: ThreadSnapshot = {
      id, cwd: prepared.cwd, project: prepared.project, name, namePending: !requestedName,
      state: "starting", sessionOrigin: "created", checkout: prepared.checkout,
      projectTrusted: input.projectTrusted === true,
      createdAt: now, updatedAt: now, lastEvent: "worker spawning", activity: "Starting worker",
    };
    this.records.set(id, record);
    await this.persistAndBroadcast();
    return await this.startWorker(record, ["--session-dir", sessionDir], input.prompt);
  }

  private async adopt(input: AdoptThreadInput): Promise<ThreadSnapshot> {
    if (!input || typeof input.sessionFile !== "string" || input.sessionFile.trim() === "") throw new Error("A persisted session file is required");
    const metadata = await readSessionMetadata(input.sessionFile);
    this.assertSessionAvailable(metadata.file);
    const project = await canonicalProject(metadata.cwd);
    const repositoryRoot = await gitRoot(metadata.cwd);
    if (repositoryRoot && input.allowSharedCheckout !== true) {
      throw new Error("Adopted Git sessions resume in their persisted checkout; explicit shared-checkout approval is required");
    }
    const now = new Date().toISOString();
    const record: ThreadSnapshot = {
      id: randomUUID(), cwd: metadata.cwd, project,
      name: input.name?.trim() || metadata.name || firstUsefulLine(metadata.searchText) || basename(metadata.cwd) || "Adopted thread",
      state: "starting", sessionFile: metadata.file, sessionId: metadata.id, sessionOrigin: "adopted",
      checkout: repositoryRoot
        ? { mode: "shared", path: repositoryRoot, repositoryRoot, managed: false, warning: "Adopted session uses its existing shared checkout" }
        : { mode: "directory", path: metadata.cwd, managed: false },
      projectTrusted: input.projectTrusted === true,
      createdAt: now, updatedAt: now, lastEvent: "adopting persisted session", activity: "Starting adopted session",
      transcriptMetadata: metadata.searchText,
    };
    // No await between the ownership check and reservation: concurrent requests cannot both win.
    this.assertSessionAvailable(metadata.file);
    this.records.set(record.id, record);
    await this.persistAndBroadcast();
    return await this.startWorker(record, ["--session", metadata.file]);
  }

  private async resume(id: string): Promise<ThreadSnapshot> {
    const record = this.requireRecord(id);
    if (record.state !== "stopped" && record.state !== "failed") throw new Error("Only stopped or failed threads can be resumed");
    if (this.workers.has(id)) throw new Error("The previous worker process has not exited yet");
    if (this.lifecycleOperations.has(id)) throw new Error("Another lifecycle operation is already in progress for this thread");
    if (!record.sessionFile) throw new Error("This thread has no persisted session to resume");
    this.lifecycleOperations.add(id);
    try {
      const metadata = await readSessionMetadata(record.sessionFile);
      if (this.workers.has(id)) throw new Error("The thread was resumed by another request");
      this.assertSessionAvailable(metadata.file, id);
      try {
        if (!(await stat(record.cwd)).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error(`The worker checkout no longer exists: ${record.cwd}`);
      }
      record.sessionFile = metadata.file;
      record.error = undefined;
      return await this.startWorker(record, ["--session", metadata.file]);
    } finally {
      this.lifecycleOperations.delete(id);
    }
  }

  private async startWorker(record: ThreadSnapshot, sessionArgs: string[], prompt?: string): Promise<ThreadSnapshot> {
    if (this.workers.has(record.id)) throw new Error("A worker already owns this thread");
    record.state = "starting";
    record.updatedAt = new Date().toISOString();
    record.lastEvent = "worker spawning";
    record.activity = "Starting worker";
    record.error = undefined;
    const trustArg = record.projectTrusted ? "--approve" : "--no-approve";
    const nameArgs = record.namePending ? [] : ["--name", record.name];
    const args = [...this.workerArgs, "--mode", "rpc", trustArg, ...sessionArgs, ...nameArgs];
    const env: NodeJS.ProcessEnv = { ...process.env, PI_AGENT_VIEW_SUPERVISED_WORKER: "1" };
    if (record.namePending) env.PI_AGENT_VIEW_AUTO_NAME = "1";
    else delete env.PI_AGENT_VIEW_AUTO_NAME;
    const child = spawn(this.workerCommand, args, {
      cwd: record.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const worker: ManagedWorker = { record, process: child, stopRequested: false, rpcSequence: 0, pending: new Map() };
    this.workers.set(record.id, worker);
    record.pid = child.pid;
    await this.persistAndBroadcast();

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    readJsonLines(child.stdout, (value) => this.onWorkerMessage(worker, value), (error) => {
      this.failWorker(worker, error.message);
      void terminateWorker(child);
    }, { maximumLineLength: MAX_WORKER_JSONL });
    child.once("error", (error) => {
      this.rejectPending(worker, error);
      this.failWorker(worker, `Could not start worker: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.rejectPending(worker, new Error("Worker exited"));
      this.workers.delete(record.id);
      record.pid = undefined;
      record.pendingRequest = undefined;
      if (worker.stopRequested) this.update(record, "stopped", "worker stopped", "Stopped");
      else if (record.state === "failed") {
        record.updatedAt = new Date().toISOString();
        void this.persist();
        this.broadcast();
      } else this.update(record, "failed", `Worker exited (${signal ?? code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`, "Worker failed");
    });

    try {
      const stateResponse = await this.rpc(worker, { type: "get_state" });
      const data = isObject(stateResponse.data) ? stateResponse.data : undefined;
      if (typeof data?.sessionFile === "string") {
        const sessionFile = await resolveWorkerSessionFile(data.sessionFile, record, this.paths.sessionsDir);
        if (record.sessionFile && sessionFile !== record.sessionFile) throw new Error("Worker opened a different session than requested");
        record.sessionFile = sessionFile;
      }
      if (typeof data?.sessionId === "string") record.sessionId = data.sessionId;
      if (record.namePending && typeof data?.sessionName === "string" && data.sessionName.trim()) {
        record.name = data.sessionName.trim();
        record.namePending = false;
      }
      if (!record.sessionFile) throw new Error("Worker did not provide a persisted session file");
      this.update(record, "ready", "worker ready", record.transcriptMetadata ? "Session ready" : "Ready for a prompt");
      if (prompt?.trim()) await this.rpc(worker, { type: "prompt", message: prompt.trim() });
      await this.persist();
      return { ...record };
    } catch (cause) {
      this.failWorker(worker, errorMessage(cause));
      if (!child.killed) child.kill("SIGTERM");
      throw cause;
    }
  }

  private async sendMessage(id: string, modeValue: unknown, messageValue: unknown): Promise<ThreadSnapshot> {
    const worker = this.requireWorker(id);
    const mode = modeValue as ThreadMessageMode;
    if (mode !== "prompt" && mode !== "steer" && mode !== "followUp") throw new Error("Unknown message delivery mode");
    if (typeof messageValue !== "string" || !messageValue.trim()) throw new Error("A non-empty message is required");
    if (mode === "prompt" && worker.record.state !== "ready") throw new Error("Normal prompts require a ready thread");
    if (mode === "steer" && worker.record.state !== "working") throw new Error("Steering requires a working thread");
    this.reserveOperation(id, "Another input operation is already in progress for this thread");
    try {
      const rpcType = mode === "followUp" ? "follow_up" : mode;
      await this.rpc(worker, { type: rpcType, message: messageValue.trim() });
      const activity = mode === "steer" ? "Steering queued" : mode === "followUp" ? "Follow-up queued" : "Prompt accepted";
      if (mode === "prompt") this.update(worker.record, "working", "prompt accepted", activity);
      else {
        worker.record.activity = activity;
        worker.record.updatedAt = new Date().toISOString();
        await this.persistAndBroadcast();
      }
      return { ...worker.record };
    } finally {
      this.lifecycleOperations.delete(id);
    }
  }

  private async answer(id: string, input: Partial<UiResponseInput>): Promise<ThreadSnapshot> {
    const worker = this.requireWorker(id);
    this.reserveOperation(id, "Another input operation is already in progress for this thread");
    try {
      const pending = worker.record.pendingRequest;
      if (!pending) throw new Error("This thread has no outstanding input request");
      if (input.requestId !== pending.id) throw new Error("The input request is no longer current; refresh the preview and try again");
      const response: Record<string, unknown> = { type: "extension_ui_response", id: pending.id };
      if (input.cancelled) response.cancelled = true;
      else if (pending.method === "confirm") {
        if (typeof input.confirmed !== "boolean") throw new Error("A confirmation answer is required");
        response.confirmed = input.confirmed;
      } else {
        if (typeof input.value !== "string") throw new Error("A response value is required");
        if (pending.method === "select" && !pending.options?.includes(input.value)) throw new Error("The selected choice is not available");
        response.value = input.value;
      }
      await this.writeWorker(worker, response);
      worker.record.pendingRequest = undefined;
      this.update(worker.record, "working", "input delivered", "Answer delivered; worker continuing");
      await this.persist();
      return { ...worker.record };
    } finally {
      this.lifecycleOperations.delete(id);
    }
  }

  private async abort(id: string): Promise<ThreadSnapshot> {
    const worker = this.requireWorker(id);
    await this.rpc(worker, { type: "abort" });
    worker.record.activity = "Abort requested";
    worker.record.updatedAt = new Date().toISOString();
    await this.persistAndBroadcast();
    return { ...worker.record };
  }

  private async transcript(id: string, cursor: string | undefined, requestedLimit: number, before?: string): Promise<TranscriptPage> {
    const record = this.requireRecord(id);
    if (!record.sessionFile) throw new Error("This thread has no persisted transcript");
    if (cursor && before) throw new Error("Transcript requests cannot use both since and before cursors");
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE, Math.floor(requestedLimit))) : 100;
    try {
      await lstat(record.sessionFile);
    } catch (cause) {
      const deferredEmptySession = (cause as NodeJS.ErrnoException).code === "ENOENT"
        && record.sessionOrigin === "created" && this.workers.has(id) && !cursor && !before;
      if (deferredEmptySession) return { entries: [], hasMore: false };
      throw cause;
    }
    return await readTranscriptPage(record.sessionFile, cursor, limit, before);
  }

  private async stop(id: string): Promise<ThreadSnapshot> {
    const record = this.requireRecord(id);
    if (this.lifecycleOperations.has(id)) throw new Error("Another lifecycle operation is already in progress for this thread");
    const worker = this.workers.get(id);
    if (!worker) {
      this.update(record, "stopped", "worker already stopped", "Stopped");
      return { ...record };
    }
    this.lifecycleOperations.add(id);
    try {
      worker.stopRequested = true;
      this.update(record, "stopped", "stop requested", "Stopping worker");
      await terminateWorker(worker.process);
      return { ...record };
    } finally {
      this.lifecycleOperations.delete(id);
    }
  }

  private async delete(id: string, confirmed: boolean): Promise<DeleteThreadResult> {
    if (!confirmed) throw new Error("Thread deletion requires explicit confirmation");
    const record = this.requireRecord(id);
    if (record.state !== "stopped") throw new Error("Only stopped threads can be deleted");
    if (this.workers.has(id)) throw new Error("Wait for the stopped worker process to exit before deleting it");
    if (this.lifecycleOperations.has(id)) throw new Error("Another lifecycle operation is already in progress for this thread");
    this.lifecycleOperations.add(id);
    try {
      const result: DeleteThreadResult = { id, recordRemoved: false, transcriptDeleted: false, checkoutRemoved: false, preservedPaths: [], warnings: [] };
      await this.cleanupCheckout(record, result);
      if (record.sessionOrigin === "adopted") {
        if (record.sessionFile) result.preservedPaths.push(record.sessionFile);
        result.warnings.push("The adopted Pi session was preserved");
      } else {
        const sessionDir = join(this.paths.sessionsDir, id);
        const safe = record.sessionFile && isPathInside(sessionDir, record.sessionFile);
        if (!safe) {
          if (record.sessionFile) result.preservedPaths.push(record.sessionFile);
          result.warnings.push("The transcript path was outside the managed session directory and was preserved");
        } else {
          try {
            await rm(sessionDir, { recursive: true, force: true });
            result.transcriptDeleted = true;
          } catch (cause) {
            result.preservedPaths.push(sessionDir);
            result.warnings.push(`Could not remove managed transcript data: ${errorMessage(cause)}`);
          }
        }
      }
      this.records.delete(id);
      result.recordRemoved = true;
      await this.persistAndBroadcast();
      return result;
    } finally {
      this.lifecycleOperations.delete(id);
    }
  }

  private async cleanupCheckout(record: ThreadSnapshot, result: DeleteThreadResult): Promise<void> {
    const checkout = record.checkout;
    if (checkout.mode !== "worktree" || !checkout.managed || !checkout.repositoryRoot) {
      if (checkout.mode === "shared") result.warnings.push("The shared checkout was not removed");
      return;
    }
    let exists = true;
    try { await lstat(checkout.path); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else throw cause;
    }
    if (!exists) {
      await git(checkout.repositoryRoot, ["worktree", "prune"]).catch(() => undefined);
      result.warnings.push(`Managed worktree was already removed externally: ${checkout.path}`);
      if (checkout.branch) result.warnings.push(`Preserved Git branch: ${checkout.branch}`);
      return;
    }
    const status = await git(checkout.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.stdout.trim()) {
      result.preservedPaths.push(checkout.path);
      result.warnings.push("Managed worktree has uncommitted changes and was preserved");
      return;
    }
    if (checkout.baseCommit) {
      const head = (await git(checkout.path, ["rev-parse", "HEAD"])).stdout.trim();
      if (head !== checkout.baseCommit) {
        const count = Number((await git(checkout.path, ["rev-list", "--count", `${checkout.baseCommit}..HEAD`])).stdout.trim());
        result.preservedPaths.push(checkout.path);
        result.warnings.push(Number.isFinite(count) && count > 0
          ? `Managed worktree contains ${count} commit(s) created after launch that may be unpushed and was preserved`
          : "Managed worktree history diverged from its launch commit and was preserved");
        return;
      }
    }
    await git(checkout.repositoryRoot, ["worktree", "remove", checkout.path]);
    if (checkout.branch) await git(checkout.repositoryRoot, ["branch", "-D", checkout.branch]);
    result.checkoutRemoved = true;
  }

  private assertSessionAvailable(sessionFile: string, ownerId?: string): void {
    const owner = [...this.records.values()].find((record) => record.id !== ownerId && record.sessionFile === sessionFile);
    if (owner) throw new Error(`Session is already owned by supervised thread "${owner.name}"`);
  }

  private reserveOperation(id: string, message: string): void {
    if (this.lifecycleOperations.has(id)) throw new Error(message);
    this.lifecycleOperations.add(id);
  }

  private requireWorker(id: string): ManagedWorker {
    this.requireRecord(id);
    const worker = this.workers.get(id);
    if (!worker) throw new Error("The worker is not running; resume it before sending input");
    return worker;
  }

  private requireRecord(id: string): ThreadSnapshot {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown thread: ${id}`);
    return record;
  }

  private onWorkerMessage(worker: ManagedWorker, value: unknown): void {
    if (!isObject(value)) return;
    if (value.type === "response" && typeof value.id === "string") {
      const pending = worker.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer);
        worker.pending.delete(value.id);
        if (value.success === false) pending.reject(new Error(typeof value.error === "string" ? value.error : "RPC command failed"));
        else pending.resolve(value);
      }
      return;
    }

    const event = typeof value.type === "string" ? value.type : "unknown event";
    const activity = activityFromEvent(value);
    if (activity) {
      worker.record.activity = activity;
      worker.record.transcriptMetadata = appendBounded(worker.record.transcriptMetadata, activity, MAX_SEARCH_TEXT);
    }
    if (event === "agent_start") {
      worker.record.recentOutput = undefined;
      this.update(worker.record, "working", event, activity ?? "Agent working");
    }
    else if (event === "agent_settled") {
      worker.record.pendingRequest = undefined;
      if (worker.record.state !== "failed" && worker.record.state !== "stopped") this.update(worker.record, "ready", event, worker.record.activity ?? "Ready");
    } else if (event === "session_info_changed" && typeof value.name === "string" && value.name.trim()) {
      worker.record.name = value.name.trim();
      worker.record.namePending = false;
      this.update(worker.record, worker.record.state, event, worker.record.activity ?? "Thread named");
    } else if (event === "extension_ui_request" && expectsUiResponse(value)) {
      worker.record.pendingRequest = pendingUiRequest(value);
      this.update(worker.record, "needs-input", event, activity ?? "Waiting for input");
    } else if (isTextDelta(value)) {
      worker.record.recentOutput = appendBounded(worker.record.recentOutput, value.assistantMessageEvent.delta as string, MAX_RECENT_OUTPUT, "");
      worker.record.updatedAt = new Date().toISOString();
      this.broadcast();
    } else if (event === "message_end" && isObject(value.message) && value.message.role === "assistant") {
      const finalized = messageText(value.message);
      if (finalized) worker.record.recentOutput = finalized.slice(-MAX_RECENT_OUTPUT);
      if (isAgentError(value)) this.update(worker.record, "failed", "agent error", "Agent failed");
      else {
        worker.record.updatedAt = new Date().toISOString();
        void this.persist();
        this.broadcast();
      }
    } else if (isAgentError(value)) this.update(worker.record, "failed", "agent error", "Agent failed");
    else {
      worker.record.lastEvent = event;
      worker.record.updatedAt = new Date().toISOString();
      void this.persist();
      this.broadcast();
    }
  }

  private rpc(worker: ManagedWorker, command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!worker.process.stdin.writable) return Promise.reject(new Error("Worker input is closed"));
    const id = `supervisor-${++worker.rpcSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        reject(new Error(`Worker RPC timed out: ${String(command.type)}`));
      }, this.workerRpcTimeoutMs);
      worker.pending.set(id, { resolve, reject, timer });
      worker.process.stdin.write(encodeJsonLine({ ...command, id }), (error) => {
        if (error) {
          clearTimeout(timer);
          worker.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private writeWorker(worker: ManagedWorker, message: Record<string, unknown>): Promise<void> {
    if (!worker.process.stdin.writable) return Promise.reject(new Error("Worker input is closed; your reply was not delivered"));
    return new Promise((resolve, reject) => worker.process.stdin.write(encodeJsonLine(message), (error) => {
      if (error) reject(new Error(`Your reply was not delivered: ${error.message}`));
      else resolve();
    }));
  }

  private failWorker(worker: ManagedWorker, message: string): void {
    if (worker.record.state === "stopped") return;
    this.update(worker.record, "failed", message, "Worker failed");
  }

  private rejectPending(worker: ManagedWorker, error: Error): void {
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    worker.pending.clear();
  }

  private update(record: ThreadSnapshot, state: ThreadSnapshot["state"], detail: string, activity: string): void {
    record.state = state;
    record.updatedAt = new Date().toISOString();
    record.lastEvent = detail;
    record.activity = activity;
    if (state === "failed") record.error = detail;
    void this.persist();
    this.broadcast();
  }

  private broadcast(): void {
    const message = encodeJsonLine({ type: "snapshot", data: this.snapshot() });
    for (const client of this.clients) this.writeSnapshot(client, message);
  }

  private writeSnapshot(socket: Socket, message: string): void {
    if (!socket.writable) return;
    const output = this.clientOutput.get(socket);
    if (!output) return;
    if (output.blocked) {
      output.pendingSnapshot = message; // Coalesce live updates for slow clients.
      return;
    }
    if (socket.write(message)) return;
    output.blocked = true;
    socket.once("drain", () => {
      output.blocked = false;
      const pending = output.pendingSnapshot;
      output.pendingSnapshot = undefined;
      if (pending) this.writeSnapshot(socket, pending);
    });
  }

  private send(socket: Socket, response: ServerResponse, remember = true): void {
    if (remember) {
      const history = this.clientRequests.get(socket);
      if (history?.has(response.id)) {
        history.set(response.id, response);
        while (history.size > MAX_CLIENT_REQUEST_HISTORY) {
          const completed = [...history.entries()].find(([, value]) => value !== "pending");
          if (!completed) break;
          history.delete(completed[0]);
        }
      }
    }
    if (socket.writable) socket.write(encodeJsonLine(response));
  }

  private async persistAndBroadcast(): Promise<void> {
    await this.persist();
    this.broadcast();
  }

  private persist(): Promise<void> {
    const registry: RegistryFile = { version: 4, threads: [...this.records.values()].map((record) => ({ ...record })) };
    this.persistTail = this.persistTail.catch(() => undefined).then(async () => {
      const temporary = `${this.paths.registryPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.paths.registryPath);
      await chmod(this.paths.registryPath, 0o600);
    });
    return this.persistTail;
  }

  private async loadAndReconcile(): Promise<void> {
    let registry: RegistryFile | undefined;
    try {
      await assertUserOwnedFile(this.paths.registryPath);
      registry = JSON.parse(await readFile(this.paths.registryPath, "utf8")) as RegistryFile;
      if (!registry || !Array.isArray(registry.threads)) throw new Error("Registry does not contain a thread list");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read supervisor registry: ${errorMessage(cause)}`);
    }
    for (const saved of registry?.threads ?? []) {
      const record: ThreadSnapshot = {
        ...saved,
        project: saved.project || saved.cwd,
        sessionOrigin: saved.sessionOrigin || "created",
        checkout: saved.checkout ?? { mode: "shared", path: saved.cwd, repositoryRoot: saved.project, managed: false, warning: "Legacy thread uses its existing checkout" },
        projectTrusted: saved.projectTrusted === true,
      };
      if (record.state === "starting" || record.state === "working" || record.state === "needs-input" || record.state === "ready") {
        if (record.pid && isProcessAlive(record.pid)) await terminatePid(record.pid);
        record.pid = undefined;
        record.pendingRequest = undefined;
        record.state = "failed";
        record.error = "Supervisor restarted; the worker connection was lost and can be resumed from its persisted session";
        record.lastEvent = "reconciled after supervisor restart";
        record.activity = "Worker connection lost; resume available";
        record.updatedAt = new Date().toISOString();
      }
      this.records.set(record.id, record);
    }
    await this.persist();
  }
}

async function canonicalProject(cwd: string): Promise<string> {
  return await gitRoot(cwd) ?? cwd;
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    return root ? await realpath(root) : undefined;
  } catch { return undefined; }
}

async function prepareCheckout(
  selectedCwd: string,
  id: string,
  worktreesDir: string,
  isolation: "required" | "shared",
): Promise<{ cwd: string; project: string; checkout: ThreadCheckout }> {
  const repositoryRoot = await gitRoot(selectedCwd);
  if (!repositoryRoot) return {
    cwd: selectedCwd,
    project: selectedCwd,
    checkout: { mode: "directory", path: selectedCwd, managed: false },
  };
  if (isolation === "shared") return {
    cwd: selectedCwd,
    project: repositoryRoot,
    checkout: {
      mode: "shared", path: repositoryRoot, repositoryRoot, managed: false,
      warning: "Isolation was explicitly disabled; concurrent workers may modify the same checkout",
    },
  };

  const checkoutPath = join(worktreesDir, id);
  const branch = `pi-agent-view/${id}`;
  const baseCommit = (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  if (!baseCommit) throw new Error("Cannot isolate this Git repository because HEAD does not name a commit");
  const subdirectory = relative(repositoryRoot, selectedCwd);
  try {
    await git(repositoryRoot, ["worktree", "add", "-b", branch, checkoutPath, baseCommit], 15_000);
  } catch (cause) {
    throw new Error(`Required Git worktree isolation failed; no worker was started. Choose shared checkout explicitly only if concurrent edits are safe: ${errorMessage(cause)}`);
  }
  const workerCwd = resolve(checkoutPath, subdirectory);
  if (!isPathInside(checkoutPath, workerCwd)) {
    await removeUnusedCheckout({ mode: "worktree", path: checkoutPath, repositoryRoot, branch, baseCommit, managed: true });
    throw new Error("Selected working directory is outside the Git repository");
  }
  return {
    cwd: workerCwd,
    project: repositoryRoot,
    checkout: { mode: "worktree", path: checkoutPath, repositoryRoot, branch, baseCommit, managed: true },
  };
}

async function removeUnusedCheckout(checkout: ThreadCheckout): Promise<void> {
  if (!checkout.repositoryRoot) return;
  await git(checkout.repositoryRoot, ["worktree", "remove", "--force", checkout.path]).catch(() => undefined);
  if (checkout.branch) await git(checkout.repositoryRoot, ["branch", "-D", checkout.branch]).catch(() => undefined);
}

async function git(cwd: string, args: string[], timeout = 5_000): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", ["-C", cwd, ...args], { timeout, maxBuffer: 1024 * 1024 });
  } catch (cause) {
    const detail = cause as Error & { stderr?: string };
    throw new Error(`git ${args.join(" ")} failed: ${detail.stderr?.trim() || detail.message}`);
  }
}

async function resolveWorkerSessionFile(reportedPath: string, record: ThreadSnapshot, sessionsRoot: string): Promise<string> {
  if (!isAbsolute(reportedPath)) throw new Error("Worker reported a relative session path");
  const absolutePath = resolve(reportedPath);
  let sessionFile: string;
  try {
    sessionFile = await realpath(absolutePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || record.sessionOrigin !== "created") throw cause;
    const canonicalParent = await realpath(dirname(absolutePath));
    sessionFile = join(canonicalParent, basename(absolutePath));
  }

  if (record.sessionOrigin === "created") {
    const managedSessionDir = await realpath(join(sessionsRoot, record.id));
    if (!isPathInside(managedSessionDir, sessionFile)) throw new Error("Worker reported a session path outside its managed directory");
  }
  return sessionFile;
}

async function readSessionMetadata(inputPath: string): Promise<SessionMetadata> {
  const file = await realpath(inputPath);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("The persisted session path is not a file");
  const handle = await open(file, "r");
  try {
    const headLength = Math.min(info.size, 64 * 1024);
    const tailLength = Math.min(Math.max(0, info.size - headLength), MAX_METADATA_BYTES - headLength);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    const newline = head.indexOf(0x0a);
    if (newline < 0) throw new Error("Invalid Pi session: header is too large or missing a newline");
    const header = JSON.parse(head.subarray(0, newline).toString("utf8")) as unknown;
    if (!isObject(header) || header.type !== "session" || typeof header.cwd !== "string" || !header.cwd) throw new Error("Invalid Pi session header");
    const cwd = await realpath(header.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("The session working directory no longer exists");

    let sample = head.toString("utf8");
    if (tailLength > 0) {
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, info.size - tailLength);
      sample += `\n${tail.toString("utf8").replace(/^[^\n]*\n/, "")}`;
    }
    let name: string | undefined;
    const searchable: string[] = [];
    for (const line of sample.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isObject(value)) continue;
        if (value.type === "session_info" && typeof value.name === "string") name = value.name;
        collectText(value, searchable);
      } catch { /* A partial boundary line is expected in the bounded tail sample. */ }
    }
    return {
      file, cwd,
      id: typeof header.id === "string" ? header.id : undefined,
      name,
      searchText: searchable.join(" ").replace(/\s+/g, " ").trim().slice(-MAX_SEARCH_TEXT),
    };
  } finally {
    await handle.close();
  }
}

function collectText(value: Record<string, unknown>, output: string[]): void {
  if (output.join(" ").length >= MAX_SEARCH_TEXT * 2) return;
  if (typeof value.name === "string") output.push(value.name);
  if (!isObject(value.message)) return;
  const content = value.message.content;
  if (typeof content === "string") output.push(content);
  else if (Array.isArray(content)) for (const block of content) if (isObject(block) && typeof block.text === "string") output.push(block.text);
}

function activityFromEvent(value: Record<string, unknown>): string | undefined {
  if (value.type === "tool_execution_start" && typeof value.toolName === "string") return `Using ${value.toolName}`;
  if (value.type === "extension_ui_request") return typeof value.title === "string" ? `Waiting: ${value.title}` : "Waiting for input";
  if (value.type === "message_update" && isObject(value.assistantMessageEvent) && value.assistantMessageEvent.type === "text_delta" && typeof value.assistantMessageEvent.delta === "string") {
    return compactActivity(value.assistantMessageEvent.delta);
  }
  if (value.type === "message_end" && isObject(value.message) && value.message.role === "assistant") {
    const text: string[] = [];
    const content = value.message.content;
    if (Array.isArray(content)) for (const block of content) if (isObject(block) && typeof block.text === "string") text.push(block.text);
    return compactActivity(text.join(" "));
  }
  return undefined;
}

function compactActivity(text: string): string | undefined {
  const value = text.replace(/\s+/g, " ").trim();
  return value ? value.slice(-160) : undefined;
}

function expectsUiResponse(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && (value.method === "select" || value.method === "confirm" || value.method === "input" || value.method === "editor");
}

function pendingUiRequest(value: Record<string, unknown>): PendingUiRequest {
  return {
    id: String(value.id),
    method: value.method as PendingUiRequest["method"],
    title: typeof value.title === "string" ? value.title.slice(0, MAX_UI_TEXT) : undefined,
    message: typeof value.message === "string" ? value.message.slice(0, MAX_UI_TEXT) : undefined,
    options: Array.isArray(value.options) ? value.options.filter((item): item is string => typeof item === "string").slice(0, 100).map((item) => item.slice(0, MAX_UI_TEXT)) : undefined,
    placeholder: typeof value.placeholder === "string" ? value.placeholder.slice(0, MAX_UI_TEXT) : undefined,
    prefill: typeof value.prefill === "string" ? value.prefill.slice(0, MAX_RECENT_OUTPUT) : undefined,
  };
}

function isTextDelta(value: Record<string, unknown>): value is Record<string, unknown> & { assistantMessageEvent: Record<string, unknown> & { delta: string } } {
  return value.type === "message_update" && isObject(value.assistantMessageEvent)
    && value.assistantMessageEvent.type === "text_delta" && typeof value.assistantMessageEvent.delta === "string";
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(isObject).map((block) => typeof block.text === "string" ? block.text : "").join("");
}

function appendBounded(current: string | undefined, next: string, maximum: number, separator = " "): string {
  const combined = `${current ?? ""}${current ? separator : ""}${next}`;
  return (separator ? combined.trim() : combined).slice(-maximum);
}

async function readTranscriptPage(sessionFile: string, cursor: string | undefined, limit: number, before?: string): Promise<TranscriptPage> {
  const stream = createReadStream(sessionFile);
  const entries: TranscriptEntry[] = [];
  let foundCursor = cursor === undefined;
  let foundBefore = before === undefined;
  let matchingEntries = 0;

  await new Promise<void>((resolve, reject) => {
    const dispose = readJsonLines(stream, (value) => {
      if (!isObject(value) || value.type === "session" || typeof value.id !== "string") return;
      const entry = boundedTranscriptEntry(value);
      if (before !== undefined) {
        if (entry.id === before) { foundBefore = true; return; }
        if (foundBefore) return;
        matchingEntries++;
        entries.push(entry);
        if (entries.length > limit) entries.shift();
        return;
      }
      if (cursor === undefined) {
        matchingEntries++;
        entries.push(entry);
        if (entries.length > limit) entries.shift();
        return;
      }
      if (!foundCursor) {
        if (entry.id === cursor) foundCursor = true;
        return;
      }
      if (entries.length <= limit) entries.push(entry);
    }, (error) => {
      dispose();
      stream.destroy();
      reject(new Error(`Cannot read thread transcript: ${error.message}`));
    });
    stream.once("error", reject);
    stream.once("end", () => { dispose(); resolve(); });
  });

  if (!foundCursor || !foundBefore) throw new Error("Transcript cursor is no longer available");
  const hasMore = cursor === undefined || before !== undefined ? matchingEntries > limit : entries.length > limit;
  if (entries.length > limit) entries.length = limit;
  return { entries, startCursor: entries[0]?.id, cursor: entries.at(-1)?.id ?? cursor, hasMore };
}

function boundedTranscriptEntry(value: Record<string, unknown>): TranscriptEntry {
  const entry = value as TranscriptEntry;
  const serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized) <= MAX_TRANSCRIPT_ENTRY_BYTES) return entry;
  return {
    id: entry.id,
    type: "truncated",
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    originalType: entry.type,
    message: `Entry omitted from takeover rendering because it exceeds ${MAX_TRANSCRIPT_ENTRY_BYTES} bytes; it remains intact in the Pi session file.`,
  };
}

function firstUsefulLine(text: string): string | undefined {
  const line = text.split(/[\r\n]/).map((value) => value.trim()).find(Boolean);
  return line?.slice(0, 80);
}

function payloadId(payload: unknown): string {
  return String((payload as { id?: unknown } | undefined)?.id ?? "");
}

function isPathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("PI_AGENT_VIEW_RPC_TIMEOUT_MS must be a positive integer");
  return parsed;
}

function parseWorkerArgs(value: string | undefined): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("PI_AGENT_VIEW_WORKER_ARGS must be a JSON string array");
  return parsed;
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Supervisor state path is not a real directory: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`Supervisor state path is not owned by the current user: ${path}`);
  await chmod(path, 0o700);
}

async function assertUserOwnedFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Supervisor state file is not a regular file: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`Supervisor state file is not owned by the current user: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Supervisor state file permissions are too broad: ${path}`);
}

async function acquireSupervisorLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      await chmod(lockPath, 0o600);
      return handle;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      let ownerPid: number | undefined;
      try {
        await assertUserOwnedFile(lockPath);
        const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
        if (typeof value.pid === "number") ownerPid = value.pid;
      } catch (readCause) {
        throw new Error(`Cannot validate existing supervisor lock: ${errorMessage(readCause)}`);
      }
      if (ownerPid && isProcessAlive(ownerPid)) throw new Error(`A supervisor already owns this registry (pid ${ownerPid})`);
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire supervisor registry lock after removing a stale lock");
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const active = await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  if (active) throw new Error("A supervisor socket is active despite acquiring the registry lock");
  await rm(socketPath, { force: true });
}

async function terminateWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  signalPid(child.pid, "SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(1_000).then(() => false)])) return;
  signalPid(child.pid, "SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

async function terminatePid(pid: number): Promise<void> {
  signalPid(pid, "SIGTERM");
  for (let index = 0; index < 20 && isProcessAlive(pid); index++) await delay(25);
  if (isProcessAlive(pid)) signalPid(pid, "SIGKILL");
}

function signalPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentError(value: Record<string, unknown>): boolean {
  if (value.type === "message_update" && isObject(value.assistantMessageEvent)) return value.assistantMessageEvent.type === "error" && value.assistantMessageEvent.reason !== "aborted";
  if (value.type === "message_end" && isObject(value.message)) return value.message.role === "assistant" && value.message.stopReason === "error";
  return false;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
