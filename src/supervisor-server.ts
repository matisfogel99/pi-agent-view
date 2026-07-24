import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { encodeJsonLine, readJsonLines } from "./jsonl.ts";
import { getSupervisorPaths, type SupervisorPaths } from "./paths.ts";
import {
  PROTOCOL_VERSION,
  type AdoptThreadInput,
  type ClientRequest,
  type DeleteThreadResult,
  type LaunchThreadInput,
  type ServerResponse,
  type SupervisorSnapshot,
  type ThreadSnapshot,
} from "./protocol.ts";

interface RegistryFile {
  version: 1 | 2;
  threads: ThreadSnapshot[];
}

interface ManagedWorker {
  record: ThreadSnapshot;
  process: ChildProcessWithoutNullStreams;
  stopRequested: boolean;
  rpcSequence: number;
  pending: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
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
}

const execFileAsync = promisify(execFile);
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_SEARCH_TEXT = 8_000;

export class SupervisorServer {
  readonly paths: SupervisorPaths;
  private readonly workerCommand: string;
  private readonly workerArgs: string[];
  private readonly records = new Map<string, ThreadSnapshot>();
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly clients = new Set<Socket>();
  private readonly lifecycleOperations = new Set<string>();
  private server?: Server;
  private persistTail: Promise<void> = Promise.resolve();

  constructor(options: SupervisorServerOptions = {}) {
    this.paths = options.paths ?? getSupervisorPaths();
    this.workerCommand = options.workerCommand ?? process.env.PI_AGENT_VIEW_WORKER_COMMAND ?? "pi";
    this.workerArgs = options.workerArgs ?? parseWorkerArgs(process.env.PI_AGENT_VIEW_WORKER_ARGS);
  }

  async start(): Promise<void> {
    await mkdir(this.paths.sessionsDir, { recursive: true, mode: 0o700 });
    await chmod(this.paths.stateDir, 0o700);
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
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    await rm(this.paths.socketPath, { force: true });
    await this.persistTail;
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
      void this.handleRequest(socket, value as unknown as ClientRequest);
    }, (error) => this.send(socket, { id: "parse", type: "response", success: false, error: error.message }));

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
    const cwd = await realpath(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("The working directory is not a directory");
    const project = await canonicalProject(cwd);
    const id = randomUUID();
    const now = new Date().toISOString();
    const name = input.name?.trim() || firstUsefulLine(input.prompt ?? "") || `${basename(project) || "Project"} thread ${this.records.size + 1}`;
    const sessionDir = join(this.paths.sessionsDir, id);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });

    const record: ThreadSnapshot = {
      id, cwd, project, name, state: "starting", sessionOrigin: "created",
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
    const now = new Date().toISOString();
    const record: ThreadSnapshot = {
      id: randomUUID(), cwd: metadata.cwd, project,
      name: input.name?.trim() || metadata.name || firstUsefulLine(metadata.searchText) || basename(metadata.cwd) || "Adopted thread",
      state: "starting", sessionFile: metadata.file, sessionId: metadata.id, sessionOrigin: "adopted",
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
    const args = [...this.workerArgs, "--mode", "rpc", ...sessionArgs, "--name", record.name];
    const child = spawn(this.workerCommand, args, { cwd: record.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const worker: ManagedWorker = { record, process: child, stopRequested: false, rpcSequence: 0, pending: new Map() };
    this.workers.set(record.id, worker);
    record.pid = child.pid;
    await this.persistAndBroadcast();

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    readJsonLines(child.stdout, (value) => this.onWorkerMessage(worker, value), (error) => this.failWorker(worker, error.message));
    child.once("error", (error) => {
      this.rejectPending(worker, error);
      this.failWorker(worker, `Could not start worker: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.rejectPending(worker, new Error("Worker exited"));
      this.workers.delete(record.id);
      record.pid = undefined;
      if (worker.stopRequested) this.update(record, "stopped", "worker stopped", "Stopped");
      else this.update(record, "failed", `Worker exited (${signal ?? code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`, "Worker failed");
    });

    try {
      const stateResponse = await this.rpc(worker, { type: "get_state" });
      const data = isObject(stateResponse.data) ? stateResponse.data : undefined;
      if (typeof data?.sessionFile === "string") {
        const sessionFile = await realpath(data.sessionFile);
        if (record.sessionFile && sessionFile !== record.sessionFile) throw new Error("Worker opened a different session than requested");
        record.sessionFile = sessionFile;
      }
      if (typeof data?.sessionId === "string") record.sessionId = data.sessionId;
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

  private async stop(id: string): Promise<ThreadSnapshot> {
    const record = this.requireRecord(id);
    const worker = this.workers.get(id);
    if (!worker) {
      this.update(record, "stopped", "worker already stopped", "Stopped");
      return { ...record };
    }
    worker.stopRequested = true;
    worker.process.kill("SIGTERM");
    this.update(record, "stopped", "stop requested", "Stopping worker");
    return { ...record };
  }

  private async delete(id: string, confirmed: boolean): Promise<DeleteThreadResult> {
    if (!confirmed) throw new Error("Thread deletion requires explicit confirmation");
    const record = this.requireRecord(id);
    if (record.state !== "stopped") throw new Error("Only stopped threads can be deleted");
    if (this.workers.has(id)) throw new Error("Wait for the stopped worker process to exit before deleting it");
    if (this.lifecycleOperations.has(id)) throw new Error("Another lifecycle operation is already in progress for this thread");
    this.lifecycleOperations.add(id);

    const result: DeleteThreadResult = { id, recordRemoved: false, transcriptDeleted: false, preservedPaths: [], warnings: [] };
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
    try {
      await this.persistAndBroadcast();
      return result;
    } finally {
      this.lifecycleOperations.delete(id);
    }
  }

  private assertSessionAvailable(sessionFile: string, ownerId?: string): void {
    const owner = [...this.records.values()].find((record) => record.id !== ownerId && record.sessionFile === sessionFile);
    if (owner) throw new Error(`Session is already owned by supervised thread "${owner.name}"`);
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
    if (event === "agent_start") this.update(worker.record, "working", event, activity ?? "Agent working");
    else if (event === "agent_settled") {
      if (worker.record.state !== "failed" && worker.record.state !== "stopped") this.update(worker.record, "ready", event, worker.record.activity ?? "Ready");
    } else if (event === "extension_ui_request" && expectsUiResponse(value)) {
      this.update(worker.record, "needs-input", event, activity ?? "Waiting for input");
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
      }, 10_000);
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
    for (const client of this.clients) if (client.writable) client.write(message);
  }

  private send(socket: Socket, response: ServerResponse): void {
    if (socket.writable) socket.write(encodeJsonLine(response));
  }

  private async persistAndBroadcast(): Promise<void> {
    await this.persist();
    this.broadcast();
  }

  private persist(): Promise<void> {
    const registry: RegistryFile = { version: 2, threads: [...this.records.values()].map((record) => ({ ...record })) };
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
      registry = JSON.parse(await readFile(this.paths.registryPath, "utf8")) as RegistryFile;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read supervisor registry: ${errorMessage(cause)}`);
    }
    for (const saved of registry?.threads ?? []) {
      const record: ThreadSnapshot = {
        ...saved,
        project: saved.project || saved.cwd,
        sessionOrigin: saved.sessionOrigin || "created",
      };
      if (record.state === "starting" || record.state === "working" || record.state === "needs-input" || record.state === "ready") {
        if (record.pid && isProcessAlive(record.pid)) {
          try { process.kill(record.pid, "SIGTERM"); } catch { /* already exited */ }
        }
        record.pid = undefined;
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
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 2_000 });
    const root = stdout.trim();
    if (root) return await realpath(root);
  } catch { /* Non-Git projects are identified by canonical cwd. */ }
  return cwd;
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
  return value.method === "select" || value.method === "confirm" || value.method === "input" || value.method === "editor";
}

function appendBounded(current: string | undefined, next: string, maximum: number): string {
  return `${current ?? ""} ${next}`.trim().slice(-maximum);
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

function parseWorkerArgs(value: string | undefined): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("PI_AGENT_VIEW_WORKER_ARGS must be a JSON string array");
  return parsed;
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const active = await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  if (active) throw new Error("A supervisor already owns this registry");
  await rm(socketPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
