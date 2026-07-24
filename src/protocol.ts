export const PROTOCOL_VERSION = 1;

export type ThreadState = "starting" | "working" | "ready" | "failed" | "stopped";

export interface ThreadSnapshot {
  id: string;
  cwd: string;
  name: string;
  state: ThreadState;
  pid?: number;
  sessionFile?: string;
  createdAt: string;
  updatedAt: string;
  lastEvent?: string;
  error?: string;
}

export interface SupervisorSnapshot {
  protocolVersion: number;
  supervisorPid: number;
  threads: ThreadSnapshot[];
}

export interface LaunchThreadInput {
  cwd: string;
  name?: string;
  prompt?: string;
}

export interface ClientRequest {
  id: string;
  type: "request";
  method: "snapshot" | "launch" | "stop" | "shutdown";
  payload?: unknown;
}

export interface ServerResponse {
  id: string;
  type: "response";
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SnapshotEvent {
  type: "snapshot";
  data: SupervisorSnapshot;
}
