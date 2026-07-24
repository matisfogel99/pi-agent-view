import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { encodeJsonLine, readJsonLines } from "./jsonl.ts";
import { getSupervisorPaths, type SupervisorPaths } from "./paths.ts";
import {
  PROTOCOL_VERSION,
  type ClientRequest,
  type LaunchThreadInput,
  type ServerResponse,
  type SupervisorSnapshot,
  type ThreadSnapshot,
} from "./protocol.ts";

interface RegistryFile {
  version: 1;
  threads: ThreadSnapshot[];
}

interface ManagedWorker {
  record: ThreadSnapshot;
  process: ChildProcessWithoutNullStreams;
  stopRequested: boolean;
  rpcSequence: number;
  pending: Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
}

export interface SupervisorServerOptions {
  paths?: SupervisorPaths;
  workerCommand?: string;
  workerArgs?: string[];
}

export class SupervisorServer {
  readonly paths: SupervisorPaths;
  private readonly workerCommand: string;
  private readonly workerArgs: string[];
  private readonly records = new Map<string, ThreadSnapshot>();
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly clients = new Set<Socket>();
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
        case "snapshot":
          data = this.snapshot();
          break;
        case "launch":
          data = await this.launch(request.payload as LaunchThreadInput);
          break;
        case "stop":
          data = await this.stop(String((request.payload as { id?: unknown } | undefined)?.id ?? ""));
          break;
        case "shutdown":
          data = { shuttingDown: true };
          this.send(socket, { id: request.id, type: "response", success: true, data });
          setTimeout(() => void this.close().finally(() => process.exit(0)), 20).unref();
          return;
        default:
          throw new Error(`Unknown supervisor method: ${String(request.method)}`);
      }
      this.send(socket, { id: request.id, type: "response", success: true, data });
    } catch (cause) {
      this.send(socket, { id: request.id, type: "response", success: false, error: errorMessage(cause) });
    }
  }

  private async launch(input: LaunchThreadInput): Promise<ThreadSnapshot> {
    if (!input || typeof input.cwd !== "string" || input.cwd.trim() === "") throw new Error("A working directory is required");
    const cwd = await realpath(input.cwd);
    const id = randomUUID();
    const now = new Date().toISOString();
    const name = input.name?.trim() || `Thread ${this.records.size + 1}`;
    const sessionDir = join(this.paths.sessionsDir, id);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });

    const record: ThreadSnapshot = { id, cwd, name, state: "starting", createdAt: now, updatedAt: now, lastEvent: "worker spawning" };
    this.records.set(id, record);
    await this.persist();
    this.broadcast();

    const args = [...this.workerArgs, "--mode", "rpc", "--session-dir", sessionDir, "--name", name];
    const child = spawn(this.workerCommand, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const worker: ManagedWorker = { record, process: child, stopRequested: false, rpcSequence: 0, pending: new Map() };
    this.workers.set(id, worker);
    record.pid = child.pid;
    record.updatedAt = new Date().toISOString();
    void this.persist();

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
      this.workers.delete(id);
      if (worker.stopRequested) this.update(record, "stopped", "worker stopped");
      else this.update(record, "failed", `Worker exited (${signal ?? code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`);
    });

    try {
      const stateResponse = await this.rpc(worker, { type: "get_state" });
      const data = isObject(stateResponse.data) ? stateResponse.data : undefined;
      if (typeof data?.sessionFile === "string") record.sessionFile = data.sessionFile;
      this.update(record, "ready", "worker ready");
      if (input.prompt?.trim()) {
        await this.rpc(worker, { type: "prompt", message: input.prompt.trim() });
      }
      // Do not acknowledge launch until worker/session identity is durable.
      await this.persist();
      return { ...record };
    } catch (cause) {
      this.failWorker(worker, errorMessage(cause));
      throw cause;
    }
  }

  private async stop(id: string): Promise<ThreadSnapshot> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown thread: ${id}`);
    const worker = this.workers.get(id);
    if (!worker) {
      this.update(record, "stopped", "worker already stopped");
      return { ...record };
    }
    worker.stopRequested = true;
    worker.process.kill("SIGTERM");
    this.update(record, "stopped", "stop requested");
    return { ...record };
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
    if (event === "agent_start") this.update(worker.record, "working", event);
    else if (event === "agent_settled") {
      if (worker.record.state !== "failed" && worker.record.state !== "stopped") this.update(worker.record, "ready", event);
    } else if (isAgentError(value)) this.update(worker.record, "failed", "agent error");
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
    this.update(worker.record, "failed", message);
  }

  private rejectPending(worker: ManagedWorker, error: Error): void {
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    worker.pending.clear();
  }

  private update(record: ThreadSnapshot, state: ThreadSnapshot["state"], detail: string): void {
    record.state = state;
    record.updatedAt = new Date().toISOString();
    record.lastEvent = detail;
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

  private persist(): Promise<void> {
    const registry: RegistryFile = { version: 1, threads: [...this.records.values()].map((record) => ({ ...record })) };
    this.persistTail = this.persistTail.then(async () => {
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
      const record = { ...saved };
      if (record.state === "starting" || record.state === "working" || record.state === "ready") {
        if (record.pid && isProcessAlive(record.pid)) {
          try { process.kill(record.pid, "SIGTERM"); } catch { /* already exited */ }
        }
        record.state = "failed";
        record.error = "Supervisor restarted; the worker connection was lost and can be resumed from its persisted session";
        record.lastEvent = "reconciled after supervisor restart";
        record.updatedAt = new Date().toISOString();
      }
      this.records.set(record.id, record);
    }
    await this.persist();
  }
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
