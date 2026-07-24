import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SupervisorClientOptions {
  paths?: SupervisorPaths;
  protocolVersion?: number;
  autoStart?: boolean;
  connectTimeoutMs?: number;
}

export class SupervisorClient {
  readonly paths: SupervisorPaths;
  private readonly protocolVersion: number;
  private readonly autoStart: boolean;
  private readonly connectTimeoutMs: number;
  private socket?: Socket;
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  private current?: SupervisorSnapshot;

  constructor(options: SupervisorClientOptions = {}) {
    this.paths = options.paths ?? getSupervisorPaths();
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.autoStart = options.autoStart ?? true;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  async connect(): Promise<SupervisorSnapshot> {
    if (this.socket && this.current) return this.current;
    try {
      return await this.connectOnce();
    } catch (firstError) {
      if (!this.autoStart || isProtocolError(firstError)) throw firstError;
      await this.startDaemon();
      const deadline = Date.now() + this.connectTimeoutMs;
      let lastError: unknown = firstError;
      while (Date.now() < deadline) {
        await delay(40);
        try { return await this.connectOnce(); } catch (cause) {
          if (isProtocolError(cause)) throw cause;
          lastError = cause;
        }
      }
      throw new Error(`Could not connect to the agent-view supervisor: ${errorMessage(lastError)}`);
    }
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.current = undefined;
    const error = new Error("Supervisor client disconnected");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  onSnapshot(listener: (snapshot: SupervisorSnapshot) => void): () => void {
    this.listeners.add(listener);
    if (this.current) listener(this.current);
    return () => this.listeners.delete(listener);
  }

  async snapshot(): Promise<SupervisorSnapshot> {
    const data = await this.request("snapshot");
    return data as SupervisorSnapshot;
  }

  async launch(input: LaunchThreadInput): Promise<ThreadSnapshot> {
    return await this.request("launch", input) as ThreadSnapshot;
  }

  async stop(id: string): Promise<ThreadSnapshot> {
    return await this.request("stop", { id }) as ThreadSnapshot;
  }

  async shutdownSupervisor(): Promise<void> {
    await this.request("shutdown");
  }

  private async connectOnce(): Promise<SupervisorSnapshot> {
    this.disconnect();
    const socket = createConnection(this.paths.socketPath);
    socket.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    this.socket = socket;
    readJsonLines(socket, (value) => this.onMessage(value), (error) => this.failAll(error));
    socket.on("error", (error) => this.failAll(error));
    socket.once("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.failAll(new Error("Supervisor connection closed"));
    });
    return await this.hello();
  }

  private async hello(): Promise<SupervisorSnapshot> {
    const id = `client-${++this.sequence}`;
    const response = await this.sendAndWait(id, { id, type: "hello", protocolVersion: this.protocolVersion });
    this.setCurrent(response as SupervisorSnapshot);
    return response as SupervisorSnapshot;
  }

  private async request(method: ClientRequest["method"], payload?: unknown): Promise<unknown> {
    if (!this.socket) await this.connect();
    const id = `client-${++this.sequence}`;
    return await this.sendAndWait(id, { id, type: "request", method, payload });
  }

  private sendAndWait(id: string, message: unknown): Promise<unknown> {
    if (!this.socket?.writable) return Promise.reject(new Error("Supervisor is not connected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Supervisor request timed out"));
      }, this.connectTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(encodeJsonLine(message), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private onMessage(value: unknown): void {
    if (!isObject(value)) return;
    if (value.type === "snapshot" && isObject(value.data)) {
      this.setCurrent(value.data as unknown as SupervisorSnapshot);
      return;
    }
    if (value.type !== "response" || typeof value.id !== "string") return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    const response = value as unknown as ServerResponse;
    if (!response.success) pending.reject(new Error(response.error ?? "Supervisor request failed"));
    else pending.resolve(response.data);
  }

  private setCurrent(snapshot: SupervisorSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async startDaemon(): Promise<void> {
    const entry = fileURLToPath(new URL("./supervisor-entry.ts", import.meta.url));
    await access(entry);
    const tsxLoader = createRequire(import.meta.url).resolve("tsx");
    const child = spawn(process.execPath, ["--import", tsxLoader, entry], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PI_AGENT_VIEW_STATE_DIR: this.paths.stateDir },
    });
    child.unref();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProtocolError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("Incompatible supervisor protocol");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
