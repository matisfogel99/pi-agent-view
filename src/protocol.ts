export const PROTOCOL_VERSION = 2;

export type ThreadState = "starting" | "working" | "needs-input" | "ready" | "failed" | "stopped";
export type SessionOrigin = "created" | "adopted";

export interface ThreadSnapshot {
  id: string;
  cwd: string;
  project: string;
  name: string;
  state: ThreadState;
  pid?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionOrigin: SessionOrigin;
  createdAt: string;
  updatedAt: string;
  lastEvent?: string;
  activity?: string;
  /** Bounded, supervisor-derived text used by dashboard search. */
  transcriptMetadata?: string;
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

export interface AdoptThreadInput {
  sessionFile: string;
  name?: string;
}

export interface DeleteThreadResult {
  id: string;
  recordRemoved: boolean;
  transcriptDeleted: boolean;
  preservedPaths: string[];
  warnings: string[];
}

export type SupervisorMethod = "snapshot" | "launch" | "adopt" | "stop" | "resume" | "delete" | "shutdown";

export interface ClientRequest {
  id: string;
  type: "request";
  method: SupervisorMethod;
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
